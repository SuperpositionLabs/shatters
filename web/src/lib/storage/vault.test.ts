import { beforeEach, describe, expect, it } from "vitest";

import { MemoryAdapter } from "./adapter";
import { Vault, VaultError, VaultLockedError } from "./vault";

// Argon2id at moderate cost takes hundreds of milliseconds per derivation and
// this suite unlocks repeatedly; the interactive profile exercises the same
// code path at a cost that suits a test run.
const fast = { strength: "interactive" } as const;

describe("Vault", () => {
  let adapter: MemoryAdapter;

  beforeEach(() => {
    adapter = new MemoryAdapter();
  });

  it("round-trips a record", async () => {
    const vault = await Vault.create("correct horse", { adapter, ...fast });
    await vault.put("greeting", new TextEncoder().encode("hello"));

    expect(new TextDecoder().decode(await vault.get("greeting"))).toBe("hello");
  });

  it("survives a lock and unlock cycle", async () => {
    const vault = await Vault.create("correct horse", { adapter, ...fast });
    await vault.putJSON("session", { root: "abc", counter: 3 });
    vault.lock();

    const reopened = await Vault.unlock("correct horse", adapter);
    expect(await reopened.getJSON("session")).toEqual({
      root: "abc",
      counter: 3,
    });
  });

  it("never writes plaintext to the underlying store", async () => {
    const vault = await Vault.create("correct horse", { adapter, ...fast });
    await vault.putString("secret", "the eagle lands at dawn");

    // Whatever reaches storage must not contain the plaintext, or the vault is
    // decoration.
    for (const key of await adapter.keys()) {
      const raw = await adapter.get(key);
      expect(new TextDecoder().decode(raw!)).not.toContain("eagle");
    }
  });

  it("rejects a wrong passphrase cleanly", async () => {
    const vault = await Vault.create("correct horse", { adapter, ...fast });
    await vault.putString("secret", "value");
    vault.lock();

    // A clean error, not garbage plaintext and not a cascade of failures from
    // whatever the caller happened to read first.
    await expect(Vault.unlock("wrong horse", adapter)).rejects.toThrow(
      /incorrect passphrase/,
    );
  });

  it("refuses to read after locking", async () => {
    const vault = await Vault.create("pw", { adapter, ...fast });
    await vault.putString("secret", "value");

    vault.lock();
    expect(vault.locked).toBe(true);

    // A lock that left the key resident would be theatre.
    await expect(vault.get("secret")).rejects.toThrow(VaultLockedError);
    await expect(vault.putString("secret", "x")).rejects.toThrow(
      VaultLockedError,
    );
  });

  it("rejects a record moved to a different slot", async () => {
    const vault = await Vault.create("pw", { adapter, ...fast });
    await vault.putString("alice", "alice's data");
    await vault.putString("bob", "bob's data");

    // Swap the sealed blobs behind the vault's back.
    const alice = await adapter.get("vault:record:alice");
    await adapter.set("vault:record:bob", alice!);

    // The record name is authenticated, so the moved blob must not open.
    await expect(vault.get("bob")).rejects.toThrow(/failed to authenticate/);
  });

  it("rejects a tampered record", async () => {
    const vault = await Vault.create("pw", { adapter, ...fast });
    await vault.putString("secret", "value");

    const stored = await adapter.get("vault:record:secret");
    stored![stored!.length - 1] ^= 0xff;
    await adapter.set("vault:record:secret", stored!);

    await expect(vault.get("secret")).rejects.toThrow(/failed to authenticate/);
  });

  it("rejects a truncated record", async () => {
    const vault = await Vault.create("pw", { adapter, ...fast });
    await vault.putString("secret", "value");
    await adapter.set("vault:record:secret", new Uint8Array(8));

    await expect(vault.get("secret")).rejects.toThrow(/truncated/);
  });

  it("persists the derivation parameters so defaults can change later", async () => {
    await Vault.create("pw", { adapter, ...fast });

    const raw = await adapter.get("vault:params");
    const params = JSON.parse(new TextDecoder().decode(raw!));

    // Without these stored, raising the defaults would lock every existing
    // user out of their own history.
    expect(params.algorithm).toBe("argon2id13");
    expect(params.salt).toBeTypeOf("string");
    expect(params.opsLimit).toBeGreaterThan(0);
    expect(params.memLimit).toBeGreaterThan(0);
  });

  it("salts each vault independently", async () => {
    const second = new MemoryAdapter();
    await Vault.create("same passphrase", { adapter, ...fast });
    await Vault.create("same passphrase", { adapter: second, ...fast });

    const saltOf = async (a: MemoryAdapter) =>
      JSON.parse(new TextDecoder().decode((await a.get("vault:params"))!)).salt;

    // Comparing ciphertexts would prove nothing here - the per-write nonce
    // makes them differ even under an identical key. The property that matters
    // is that the same passphrase yields a different key on each device, so
    // work precomputed against one vault does not carry to another.
    expect(await saltOf(adapter)).not.toBe(await saltOf(second));
  });

  it("produces a different ciphertext each write", async () => {
    const vault = await Vault.create("pw", { adapter, ...fast });

    await vault.putString("x", "same");
    const first = await adapter.get("vault:record:x");
    await vault.putString("x", "same");
    const second = await adapter.get("vault:record:x");

    // Fresh nonce per write, so rewriting a value does not reveal that it is
    // unchanged.
    expect(first).not.toEqual(second);
  });

  it("returns undefined for an absent record", async () => {
    const vault = await Vault.create("pw", { adapter, ...fast });
    expect(await vault.get("nothing")).toBeUndefined();
    expect(await vault.getJSON("nothing")).toBeUndefined();
  });

  it("lists records without exposing internals", async () => {
    const vault = await Vault.create("pw", { adapter, ...fast });
    await vault.putString("conv:alice", "a");
    await vault.putString("conv:bob", "b");
    await vault.putString("identity", "i");

    expect(await vault.list("conv:")).toEqual(["conv:alice", "conv:bob"]);
    // The canary is bookkeeping, not the caller's data.
    expect(await vault.list()).not.toContain("__canary__");
  });

  it("deletes records", async () => {
    const vault = await Vault.create("pw", { adapter, ...fast });
    await vault.putString("temp", "value");
    await vault.delete("temp");

    expect(await vault.get("temp")).toBeUndefined();
  });

  it("refuses to overwrite an existing vault", async () => {
    await Vault.create("first", { adapter, ...fast });

    // Silently discarding every existing record would be catastrophic.
    await expect(
      Vault.create("second", { adapter, ...fast }),
    ).rejects.toThrow(/already exists/);
  });

  it("refuses an empty passphrase", async () => {
    await expect(Vault.create("", { adapter, ...fast })).rejects.toThrow(
      /must not be empty/,
    );
  });

  it("reports whether a vault exists", async () => {
    expect(await Vault.exists(adapter)).toBe(false);
    await Vault.create("pw", { adapter, ...fast });
    expect(await Vault.exists(adapter)).toBe(true);
  });

  it("fails to unlock storage with no vault", async () => {
    await expect(Vault.unlock("pw", adapter)).rejects.toThrow(/no vault/);
  });

  it("rejects corrupt parameters rather than guessing", async () => {
    await Vault.create("pw", { adapter, ...fast });
    await adapter.set("vault:params", new TextEncoder().encode("{not json"));

    await expect(Vault.unlock("pw", adapter)).rejects.toThrow(/corrupt/);
  });

  it("rejects an unknown derivation algorithm", async () => {
    await Vault.create("pw", { adapter, ...fast });
    await adapter.set(
      "vault:params",
      new TextEncoder().encode(
        JSON.stringify({ algorithm: "md5", salt: "x", opsLimit: 1, memLimit: 1 }),
      ),
    );

    // Falling back to a default here would silently downgrade the vault.
    await expect(Vault.unlock("pw", adapter)).rejects.toThrow(/unsupported/);
  });

  it("destroys everything it stored", async () => {
    const vault = await Vault.create("pw", { adapter, ...fast });
    await vault.putString("secret", "value");

    await vault.destroy();

    expect(await adapter.keys()).toEqual([]);
    expect(await Vault.exists(adapter)).toBe(false);
    expect(vault.locked).toBe(true);
  });

  it("throws VaultError for vault failures", async () => {
    await expect(Vault.unlock("pw", adapter)).rejects.toBeInstanceOf(VaultError);
  });
});

describe("MemoryAdapter", () => {
  it("copies values in and out", async () => {
    const adapter = new MemoryAdapter();
    const value = new Uint8Array([1, 2, 3]);

    await adapter.set("k", value);
    value[0] = 99; // mutate the caller's buffer after storing

    const stored = await adapter.get("k");
    expect(stored).toEqual(new Uint8Array([1, 2, 3]));

    stored![0] = 42; // mutate the returned buffer
    expect(await adapter.get("k")).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("filters keys by prefix", async () => {
    const adapter = new MemoryAdapter();
    await adapter.set("a:1", new Uint8Array([1]));
    await adapter.set("a:2", new Uint8Array([2]));
    await adapter.set("b:1", new Uint8Array([3]));

    expect(await adapter.keys("a:")).toEqual(["a:1", "a:2"]);
  });
});
