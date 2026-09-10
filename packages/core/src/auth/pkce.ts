import { createHash, randomBytes } from "node:crypto";

/**
 * PKCE (RFC 7636) primitives.
 *
 * Only the S256 method is implemented. `plain` exists in the RFC for
 * constrained clients that cannot compute SHA-256; Action Hub always can, and
 * offering the weaker method would only create a downgrade to negotiate.
 */
export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
}

/** Base64url without padding, as every OAuth RFC requires. */
function base64Url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Generates a verifier/challenge pair.
 *
 * 32 random bytes yield a 43-character verifier, the RFC's minimum length and
 * a full 256 bits of entropy.
 */
export function createPkcePair(): PkcePair {
  const codeVerifier = base64Url(randomBytes(32));
  const codeChallenge = base64Url(createHash("sha256").update(codeVerifier).digest());
  return { codeVerifier, codeChallenge, codeChallengeMethod: "S256" };
}

/** Random, URL-safe CSRF value for the `state` parameter. */
export function createStateValue(): string {
  return base64Url(randomBytes(16));
}
