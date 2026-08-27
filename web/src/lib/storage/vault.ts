/**
 * Encrypted local vault (docs/protocol.md §8).
 *
 * Everything the client keeps between sessions - identity keys, ratchet state,
 * message history - passes through here. The passphrase never leaves the
 * device and the derived key never reaches storage; only sealed records do.
 *
 * A stolen device therefore yields ciphertext and an Argon2id cost, not a
 * conversation.
 */
import { sodium } from "../crypto/identity";
import { type StorageAdapter, defaultAdapter } from "./adapter";

/** Where the key-derivation parameters live. Plaintext by necessity. */
const PARAMS_KEY = "vault:params";
/** Prefix for sealed records, so `keys()` can enumerate them. */
const RECORD_PREFIX = "vault:record:";
/**
 * Canary record proving a passphrase is right before anything else is read.
 *
 * A record *name*, not a storage key: `put` adds the prefix. Spelling it with
 * the prefix here double-prefixed the stored key, which still round-tripped -
 * read and write shared the mistake - but leaked the canary into `list()`.
 */
const CANARY_NAME = "__canary__";
const CANARY_PLAINTEXT = "shatters-vault-v1";

const KEY_LENGTH = 32;
const NONCE_LENGTH = 24;

export class VaultError extends Error {}
export class VaultLockedError extends VaultError {
  constructor() {
    super("vault is locked");
  }
}

/**
 * Argon2id parameters, persisted beside the data.
 *
 * Stored rather than assumed: raising the defaults later must not lock every
 * existing user out of their own history.
 */
export interface KdfParams {
  algorithm: "argon2id13";
  salt: string; // base64
  opsLimit: number;
  memLimit: number;
}

/** Cost profile for deriving the vault key. */
export type VaultStrength = "interactive" | "moderate";

export class Vault {
  private key?: Uint8Array;

  private constructor(
    private readonly adapter: StorageAdapter,
    private readonly params: KdfParams,
  ) {}

  /** True once a vault has been initialised in this storage. */
  static async exists(adapter: StorageAdapter = defaultAdapter()): Promise<boolean> {
    return (await adapter.get(PARAMS_KEY)) !== undefined;
  }

  /**
   * Creates a vault, deriving and holding the key so it is immediately usable.
   * Fails if one already exists, since overwriting would silently discard
   * every existing record.
   */
  static async create(
    passphrase: string,
    options: { adapter?: StorageAdapter; strength?: VaultStrength } = {},
  ): Promise<Vault> {
    const adapter = options.adapter ?? defaultAdapter();
    if (await Vault.exists(adapter)) {
      throw new VaultError("a vault already exists in this storage");
    }
    if (passphrase.length === 0) {
      throw new VaultError("passphrase must not be empty");
    }

    const s = await sodium();
    const salt = s.randombytes_buf(s.crypto_pwhash_SALTBYTES);
    const strength = options.strength ?? "moderate";

    const params: KdfParams = {
      algorithm: "argon2id13",
      salt: s.to_base64(salt, s.base64_variants.ORIGINAL),
      opsLimit:
        strength === "moderate"
          ? s.crypto_pwhash_OPSLIMIT_MODERATE
          : s.crypto_pwhash_OPSLIMIT_INTERACTIVE,
      memLimit:
        strength === "moderate"
          ? s.crypto_pwhash_MEMLIMIT_MODERATE
          : s.crypto_pwhash_MEMLIMIT_INTERACTIVE,
    };

    const vault = new Vault(adapter, params);
    vault.key = await deriveKey(passphrase, params);

    await adapter.set(
      PARAMS_KEY,
      new TextEncoder().encode(JSON.stringify(params)),
    );
    // Written last: a canary present means the parameters are usable.
    await vault.putString(CANARY_NAME, CANARY_PLAINTEXT);
    return vault;
  }

  /**
   * Unlocks an existing vault.
   *
   * The passphrase is checked against the canary before any real record is
   * touched, so a wrong one is a clean failure rather than a cascade of
   * authentication errors from whatever the caller happened to read first.
   */
  static async unlock(
    passphrase: string,
    adapter: StorageAdapter = defaultAdapter(),
  ): Promise<Vault> {
    const raw = await adapter.get(PARAMS_KEY);
    if (!raw) throw new VaultError("no vault in this storage");

    let params: KdfParams;
    try {
      params = JSON.parse(new TextDecoder().decode(raw)) as KdfParams;
    } catch {
      throw new VaultError("vault parameters are corrupt");
    }
    if (params.algorithm !== "argon2id13") {
      throw new VaultError(`unsupported vault algorithm ${params.algorithm}`);
    }

    const vault = new Vault(adapter, params);
    vault.key = await deriveKey(passphrase, params);

    const canary = await vault.getString(CANARY_NAME).catch(() => undefined);
    if (canary !== CANARY_PLAINTEXT) {
      vault.lock();
      throw new VaultError("incorrect passphrase");
    }
    return vault;
  }

  get locked(): boolean {
    return this.key === undefined;
  }

  /**
   * Drops the key from memory. Reads and writes fail afterwards until the
   * vault is unlocked again - a lock that left the key resident would be
   * decoration.
   */
  lock(): void {
    if (this.key) {
      // Best effort: JS gives no guarantee the buffer is not copied elsewhere,
      // but leaving the key readable would be strictly worse.
      this.key.fill(0);
      this.key = undefined;
    }
  }

  private requireKey(): Uint8Array {
    if (!this.key) throw new VaultLockedError();
    return this.key;
  }

  /** Seals and stores a record under `name`. */
  async put(name: string, value: Uint8Array): Promise<void> {
    const key = this.requireKey();
    const s = await sodium();

    const nonce = s.randombytes_buf(NONCE_LENGTH);
    // The record name is authenticated, so a blob copied from one slot to
    // another fails to open instead of impersonating the record it replaced.
    const sealed = s.crypto_aead_xchacha20poly1305_ietf_encrypt(
      value,
      new TextEncoder().encode(name),
      null,
      nonce,
      key,
    );

    const framed = new Uint8Array(nonce.length + sealed.length);
    framed.set(nonce);
    framed.set(sealed, nonce.length);
    await this.adapter.set(recordKey(name), framed);
  }

  /** Reads and opens a record, or undefined when absent. */
  async get(name: string): Promise<Uint8Array | undefined> {
    const key = this.requireKey();
    const framed = await this.adapter.get(recordKey(name));
    if (!framed) return undefined;
    if (framed.length <= NONCE_LENGTH) {
      throw new VaultError(`record ${name} is truncated`);
    }

    const s = await sodium();
    try {
      return s.crypto_aead_xchacha20poly1305_ietf_decrypt(
        null,
        framed.slice(NONCE_LENGTH),
        new TextEncoder().encode(name),
        framed.slice(0, NONCE_LENGTH),
        key,
      );
    } catch {
      throw new VaultError(`record ${name} failed to authenticate`);
    }
  }

  async putString(name: string, value: string): Promise<void> {
    await this.put(name, new TextEncoder().encode(value));
  }

  async getString(name: string): Promise<string | undefined> {
    const raw = await this.get(name);
    return raw ? new TextDecoder().decode(raw) : undefined;
  }

  async putJSON(name: string, value: unknown): Promise<void> {
    await this.putString(name, JSON.stringify(value));
  }

  async getJSON<T>(name: string): Promise<T | undefined> {
    const raw = await this.getString(name);
    return raw === undefined ? undefined : (JSON.parse(raw) as T);
  }

  async delete(name: string): Promise<void> {
    this.requireKey();
    await this.adapter.delete(recordKey(name));
  }

  /** Record names currently stored, excluding internal bookkeeping. */
  async list(prefix = ""): Promise<string[]> {
    this.requireKey();
    const keys = await this.adapter.keys(RECORD_PREFIX + prefix);
    return keys
      .map((k) => k.slice(RECORD_PREFIX.length))
      .filter((name) => name !== CANARY_NAME);
  }

  /** Destroys every record and the parameters, leaving no recoverable data. */
  async destroy(): Promise<void> {
    for (const key of await this.adapter.keys(RECORD_PREFIX)) {
      await this.adapter.delete(key);
    }
    await this.adapter.delete(PARAMS_KEY);
    this.lock();
  }
}

function recordKey(name: string): string {
  return RECORD_PREFIX + name;
}

/**
 * Argon2id key derivation. Deliberately slow, so it runs once per unlock and
 * never per record.
 */
async function deriveKey(
  passphrase: string,
  params: KdfParams,
): Promise<Uint8Array> {
  const s = await sodium();
  return s.crypto_pwhash(
    KEY_LENGTH,
    passphrase,
    s.from_base64(params.salt, s.base64_variants.ORIGINAL),
    params.opsLimit,
    params.memLimit,
    s.crypto_pwhash_ALG_ARGON2ID13,
  );
}
