/**
 * Safety numbers.
 *
 * Every key in a prekey bundle is signed by the identity key, but that only
 * proves the bundle is internally consistent. It cannot prove the identity key
 * itself is the right one: the server chooses which key to serve for an
 * account id, and a client that has never seen the real one has nothing to
 * compare against.
 *
 * A safety number is that comparison, moved to a channel the two people
 * already trust.
 */
import { sodium } from "./identity";

export const SAFETY_DOMAIN = "shatters-safety-v1";

/**
 * Iterations of the per-key hash.
 *
 * Signal uses 5200 for the same purpose. The cost is irrelevant to a user
 * comparing one number, and it makes searching for a colliding key expensive
 * rather than merely inconvenient.
 */
const ITERATIONS = 5200;

/** Digits taken from each key's digest. */
const DIGITS_PER_KEY = 30;

/**
 * Derives one party's half of the safety number.
 *
 * The identity key is folded in on every iteration, so shortcutting the chain
 * requires the key rather than just the previous digest. That property is not
 * observable from the outside - removing the fold produces a different but
 * equally well-formed number - so no test asserts it; it is here because a
 * plain hash chain would be cheaper to attack, not because anything breaks
 * without it.
 */
async function fingerprint(identityKey: Uint8Array): Promise<string> {
  const s = await sodium();
  const domain = new TextEncoder().encode(SAFETY_DOMAIN);

  let digest: Uint8Array = new Uint8Array(domain.length + identityKey.length);
  digest.set(domain);
  digest.set(identityKey, domain.length);
  digest = s.crypto_hash_sha256(digest);

  for (let i = 1; i < ITERATIONS; i++) {
    const input = new Uint8Array(digest.length + identityKey.length);
    input.set(digest);
    input.set(identityKey, digest.length);
    digest = s.crypto_hash_sha256(input);
  }

  // Digits rather than hex: people read these aloud, and a-f is ambiguous
  // over a phone line.
  let out = "";
  for (let i = 0; out.length < DIGITS_PER_KEY; i += 5) {
    const chunk =
      ((digest[i % digest.length] << 32) |
        (digest[(i + 1) % digest.length] << 24) |
        (digest[(i + 2) % digest.length] << 16) |
        (digest[(i + 3) % digest.length] << 8) |
        digest[(i + 4) % digest.length]) >>>
      0;
    out += (chunk % 100000).toString().padStart(5, "0");
  }
  return out.slice(0, DIGITS_PER_KEY);
}

/**
 * The safety number two people compare.
 *
 * The halves are sorted rather than ordered by who is asking, so both devices
 * produce the same string. A number that differed by whose screen it was on
 * would be useless for exactly the comparison it exists to support.
 */
export async function safetyNumber(
  ownIdentityKey: Uint8Array,
  peerIdentityKey: Uint8Array,
): Promise<string> {
  const [a, b] = await Promise.all([
    fingerprint(ownIdentityKey),
    fingerprint(peerIdentityKey),
  ]);
  return a < b ? a + b : b + a;
}

/** Groups the digits so they can be read aloud without losing your place. */
export function formatSafetyNumber(digits: string): string {
  const groups: string[] = [];
  for (let i = 0; i < digits.length; i += 5) {
    groups.push(digits.slice(i, i + 5));
  }
  // Two rows of six groups, which is how a 60-digit number stays scannable.
  return groups.join(" ");
}
