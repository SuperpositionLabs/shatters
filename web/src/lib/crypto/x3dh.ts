/**
 * X3DH key agreement (docs/protocol.md §7).
 *
 * Runs entirely on the user's device. The server contributes nothing beyond
 * serving the responder's public prekey bundle; it never sees an ephemeral
 * private key nor the resulting shared secret.
 *
 * The output is the 32-byte secret the Double Ratchet adopts as its initial
 * root key, plus the associated data both sides bind into the first message.
 */
import {
  type Identity,
  type SignedPrekey,
  sodium,
  verifyIdentityDhKey,
  verifySignedPrekey,
} from "./identity";
import { HASH_LENGTH, hkdfSha256 } from "./kdf";

export const X3DH_DOMAIN = "shatters-x3dh-v1";

/** Length of an X25519 public key, private key, and DH output. */
const KEY_LENGTH = 32;

/**
 * The public bundle fetched from `GET /v1/accounts/{id}/bundle`, decoded.
 * `oneTimePrekey` is absent when the responder's pool is exhausted, in which
 * case the handshake runs the three-DH variant.
 */
export interface PrekeyBundle {
  /** Ed25519 identity key - defines the account ID. */
  identityKey: Uint8Array;
  /** X25519 identity key - participates in DH2. */
  identityDhKey: Uint8Array;
  /**
   * Ed25519 signature over `"shatters-idk-v1" || identityDhKey`.
   *
   * Required. The server serves this key, so without a signature it is the one
   * value in the bundle nobody has vouched for.
   */
  identityDhSignature: Uint8Array;
  signedPrekey: SignedPrekey;
  oneTimePrekey?: { id: number; publicKey: Uint8Array };
}

/** Everything the responder needs to reconstruct the same secret. */
export interface InitialMessageHeader {
  /** Initiator's Ed25519 identity key. */
  identityKey: Uint8Array;
  /** Initiator's X25519 identity key. */
  identityDhKey: Uint8Array;
  /** Initiator's one-shot ephemeral X25519 public key. */
  ephemeralKey: Uint8Array;
  signedPrekeyId: number;
  oneTimePrekeyId?: number;
}

export interface InitiatorSession {
  /** 32-byte X3DH output - the Double Ratchet's initial root key. */
  sharedSecret: Uint8Array;
  /** Header the responder needs before it holds any session state. */
  header: InitialMessageHeader;
  /** `AD` bound into the first ratchet message. */
  associatedData: Uint8Array;
}

export interface ResponderSession {
  sharedSecret: Uint8Array;
  associatedData: Uint8Array;
}

/** The responder's private halves of the prekeys the initiator selected. */
export interface ResponderPrekeys {
  signedPrekeyPrivate: Uint8Array;
  /** Required exactly when the initiator consumed a one-time prekey. */
  oneTimePrekeyPrivate?: Uint8Array;
}

export class X3DHError extends Error {}

function assertKey(name: string, key: Uint8Array): void {
  if (key.length !== KEY_LENGTH) {
    throw new X3DHError(`${name}: expected ${KEY_LENGTH} bytes, got ${key.length}`);
  }
}

/**
 * `AD = IKa_pub || IKb_pub` (protocol §7), using the **Ed25519** identity keys.
 *
 * Those are the keys account IDs are derived from, so binding them is what ties
 * a session to the two addressable identities rather than to key material the
 * server hands out. Order is always initiator-first, so both sides agree.
 */
function associatedData(
  initiatorIdentityKey: Uint8Array,
  responderIdentityKey: Uint8Array,
): Uint8Array {
  const ad = new Uint8Array(
    initiatorIdentityKey.length + responderIdentityKey.length,
  );
  ad.set(initiatorIdentityKey);
  ad.set(responderIdentityKey, initiatorIdentityKey.length);
  return ad;
}

/**
 * Concatenates `F || DH1 || DH2 || DH3 [|| DH4]` and runs it through HKDF.
 * `F` is 32 bytes of 0xFF, per the Signal X3DH spec's curve encoding bound.
 * The DH outputs and the assembled IKM are wiped before returning.
 */
async function deriveSecret(dhs: Uint8Array[]): Promise<Uint8Array> {
  const s = await sodium();

  const f = new Uint8Array(KEY_LENGTH).fill(0xff);
  const ikm = new Uint8Array(f.length + dhs.length * KEY_LENGTH);
  ikm.set(f);
  dhs.forEach((dh, i) => ikm.set(dh, f.length + i * KEY_LENGTH));

  try {
    return await hkdfSha256(
      ikm,
      new Uint8Array(HASH_LENGTH), // salt = 0x00 * 32
      X3DH_DOMAIN,
      KEY_LENGTH,
    );
  } finally {
    s.memzero(ikm);
    for (const dh of dhs) s.memzero(dh);
  }
}

/**
 * Initiator half: consumes a fetched bundle and produces the shared secret
 * plus the header the responder will need.
 *
 * The bundle's signed prekey is verified against the bundle's identity key
 * *before* any DH runs. Skipping that check would leave the whole handshake
 * unauthenticated, since the prekeys arrive from the server rather than from
 * the peer.
 */
export async function initiateX3DH(
  ourIdentity: Identity,
  bundle: PrekeyBundle,
): Promise<InitiatorSession> {
  const s = await sodium();

  assertKey("bundle.identityKey", bundle.identityKey);
  assertKey("bundle.identityDhKey", bundle.identityDhKey);
  assertKey("bundle.signedPrekey.publicKey", bundle.signedPrekey.publicKey);
  if (bundle.oneTimePrekey) {
    assertKey("bundle.oneTimePrekey.publicKey", bundle.oneTimePrekey.publicKey);
  }

  if (!(await verifySignedPrekey(bundle.identityKey, bundle.signedPrekey))) {
    throw new X3DHError("bundle signed prekey signature does not verify");
  }
  // The DH key feeds DH2. Unverified, a malicious server could substitute its
  // own: the shared secret would still be safe, since DH1 and DH3 need the
  // signed prekey's private half, but DH2 would contribute no entropy an
  // attacker lacks - which is not what this handshake claims.
  if (
    !(await verifyIdentityDhKey(
      bundle.identityKey,
      bundle.identityDhKey,
      bundle.identityDhSignature,
    ))
  ) {
    throw new X3DHError("bundle identity DH key signature does not verify");
  }

  const ephemeral = s.crypto_kx_keypair();
  try {
    const dhs = [
      // DH1 = DH(IKa, SPKb)
      s.crypto_scalarmult(ourIdentity.dh.privateKey, bundle.signedPrekey.publicKey),
      // DH2 = DH(EKa, IKb)
      s.crypto_scalarmult(ephemeral.privateKey, bundle.identityDhKey),
      // DH3 = DH(EKa, SPKb)
      s.crypto_scalarmult(ephemeral.privateKey, bundle.signedPrekey.publicKey),
    ];
    if (bundle.oneTimePrekey) {
      // DH4 = DH(EKa, OPKb)
      dhs.push(
        s.crypto_scalarmult(
          ephemeral.privateKey,
          bundle.oneTimePrekey.publicKey,
        ),
      );
    }

    return {
      sharedSecret: await deriveSecret(dhs),
      header: {
        identityKey: ourIdentity.signing.publicKey,
        identityDhKey: ourIdentity.dh.publicKey,
        ephemeralKey: ephemeral.publicKey,
        signedPrekeyId: bundle.signedPrekey.id,
        oneTimePrekeyId: bundle.oneTimePrekey?.id,
      },
      associatedData: associatedData(
        ourIdentity.signing.publicKey,
        bundle.identityKey,
      ),
    };
  } finally {
    // The ephemeral private key is single-use by construction: keeping it
    // would forfeit the forward secrecy the ephemeral exists to provide.
    s.memzero(ephemeral.privateKey);
  }
}

/**
 * Responder half: reconstructs the same secret from the initiator's header
 * and the private prekeys the initiator selected.
 *
 * The caller is responsible for looking up `header.signedPrekeyId` /
 * `header.oneTimePrekeyId` in local storage and for deleting the one-time
 * prekey afterwards - reusing it would break forward secrecy.
 */
export async function respondX3DH(
  ourIdentity: Identity,
  prekeys: ResponderPrekeys,
  header: InitialMessageHeader,
): Promise<ResponderSession> {
  const s = await sodium();

  assertKey("header.identityKey", header.identityKey);
  assertKey("header.identityDhKey", header.identityDhKey);
  assertKey("header.ephemeralKey", header.ephemeralKey);
  assertKey("prekeys.signedPrekeyPrivate", prekeys.signedPrekeyPrivate);

  // A header claiming a one-time prekey the responder cannot supply would
  // silently derive a three-DH secret the initiator never computed, so the
  // mismatch is rejected rather than papered over.
  if ((header.oneTimePrekeyId !== undefined) !== (prekeys.oneTimePrekeyPrivate !== undefined)) {
    throw new X3DHError(
      "one-time prekey mismatch between message header and supplied prekeys",
    );
  }
  if (prekeys.oneTimePrekeyPrivate) {
    assertKey("prekeys.oneTimePrekeyPrivate", prekeys.oneTimePrekeyPrivate);
  }

  const dhs = [
    // DH1 = DH(SPKb, IKa)
    s.crypto_scalarmult(prekeys.signedPrekeyPrivate, header.identityDhKey),
    // DH2 = DH(IKb, EKa)
    s.crypto_scalarmult(ourIdentity.dh.privateKey, header.ephemeralKey),
    // DH3 = DH(SPKb, EKa)
    s.crypto_scalarmult(prekeys.signedPrekeyPrivate, header.ephemeralKey),
  ];
  if (prekeys.oneTimePrekeyPrivate) {
    // DH4 = DH(OPKb, EKa)
    dhs.push(
      s.crypto_scalarmult(prekeys.oneTimePrekeyPrivate, header.ephemeralKey),
    );
  }

  return {
    sharedSecret: await deriveSecret(dhs),
    associatedData: associatedData(
      header.identityKey,
      ourIdentity.signing.publicKey,
    ),
  };
}
