import { describe, expect, it } from "vitest";

import { generateIdentity } from "./identity";
import { formatSafetyNumber, safetyNumber } from "./safety";

describe("safetyNumber", () => {
  it("is identical on both devices", async () => {
    const alice = await generateIdentity();
    const bob = await generateIdentity();

    // A number that differed by whose screen it was on would be useless for
    // exactly the comparison it exists to support.
    const fromAlice = await safetyNumber(
      alice.signing.publicKey,
      bob.signing.publicKey,
    );
    const fromBob = await safetyNumber(
      bob.signing.publicKey,
      alice.signing.publicKey,
    );

    expect(fromAlice).toBe(fromBob);
  });

  it("is deterministic", async () => {
    const alice = await generateIdentity();
    const bob = await generateIdentity();

    expect(
      await safetyNumber(alice.signing.publicKey, bob.signing.publicKey),
    ).toBe(await safetyNumber(alice.signing.publicKey, bob.signing.publicKey));
  });

  it("changes when either key changes", async () => {
    const alice = await generateIdentity();
    const bob = await generateIdentity();
    const mallory = await generateIdentity();

    const genuine = await safetyNumber(
      alice.signing.publicKey,
      bob.signing.publicKey,
    );
    const substituted = await safetyNumber(
      alice.signing.publicKey,
      mallory.signing.publicKey,
    );

    // This is the whole point: a substituted key must be visible.
    expect(substituted).not.toBe(genuine);
  });

  it("is digits only", async () => {
    const alice = await generateIdentity();
    const bob = await generateIdentity();

    const number = await safetyNumber(
      alice.signing.publicKey,
      bob.signing.publicKey,
    );

    // People read these aloud, and a-f is ambiguous over a phone line.
    expect(number).toMatch(/^\d+$/);
    expect(number).toHaveLength(60);
  });

  it("differs between different pairs", async () => {
    const alice = await generateIdentity();
    const bob = await generateIdentity();
    const carol = await generateIdentity();

    const withBob = await safetyNumber(
      alice.signing.publicKey,
      bob.signing.publicKey,
    );
    const withCarol = await safetyNumber(
      alice.signing.publicKey,
      carol.signing.publicKey,
    );

    expect(withBob).not.toBe(withCarol);
  });

  it("does not collapse when both keys are the same", async () => {
    const alice = await generateIdentity();

    // A note to self is a degenerate case, but it must still produce a
    // well-formed number rather than something half the length.
    const number = await safetyNumber(
      alice.signing.publicKey,
      alice.signing.publicKey,
    );
    expect(number).toHaveLength(60);
  });
});

describe("formatSafetyNumber", () => {
  it("groups the digits for reading aloud", async () => {
    const alice = await generateIdentity();
    const bob = await generateIdentity();
    const number = await safetyNumber(
      alice.signing.publicKey,
      bob.signing.publicKey,
    );

    const formatted = formatSafetyNumber(number);
    expect(formatted.split(" ")).toHaveLength(12);
    for (const group of formatted.split(" ")) {
      expect(group).toHaveLength(5);
    }
    // Grouping must not alter the value being compared.
    expect(formatted.replace(/ /g, "")).toBe(number);
  });
});
