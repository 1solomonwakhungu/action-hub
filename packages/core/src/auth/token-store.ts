import type { TokenSet, TokenStore } from "./types.js";

/**
 * Process-lifetime token store.
 *
 * This is the default so that a host which supplies no store still gets
 * correct refresh behaviour within a session — it simply forgets everything on
 * exit. Anything that should survive a restart needs a real store from the
 * host (a mode-0600 file, a platform keychain, a secrets manager).
 */
export class InMemoryTokenStore implements TokenStore {
  readonly #entries = new Map<string, TokenSet>();

  get(key: string): TokenSet | undefined {
    const found = this.#entries.get(key);
    return found ? { ...found } : undefined;
  }

  set(key: string, tokens: TokenSet): void {
    this.#entries.set(key, { ...tokens });
  }

  delete(key: string): void {
    this.#entries.delete(key);
  }

  /** Keys currently holding credentials. Never returns token values. */
  keys(): string[] {
    return [...this.#entries.keys()];
  }

  clear(): void {
    this.#entries.clear();
  }
}

/**
 * Validates and normalises a persisted record back into a {@link TokenSet}.
 *
 * Host stores read from disk or a keychain, where the payload is untrusted
 * text. A malformed entry is dropped rather than thrown on: the caller then
 * behaves exactly as if no credential were stored, which degrades into a
 * re-authorization instead of a crash.
 */
export function coerceTokenSet(value: unknown): TokenSet | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;

  const accessToken = record["accessToken"];
  if (typeof accessToken !== "string" || accessToken.length === 0) return undefined;

  const refreshToken = record["refreshToken"];
  const expiresAt = record["expiresAt"];
  const scope = record["scope"];
  const obtainedAt = record["obtainedAt"];
  const tokenType = record["tokenType"];

  return {
    accessToken,
    tokenType: typeof tokenType === "string" && tokenType.length > 0 ? tokenType : "Bearer",
    expiresAt: typeof expiresAt === "number" && Number.isFinite(expiresAt) ? expiresAt : undefined,
    refreshToken:
      typeof refreshToken === "string" && refreshToken.length > 0 ? refreshToken : undefined,
    scope: typeof scope === "string" ? scope : undefined,
    obtainedAt: typeof obtainedAt === "number" && Number.isFinite(obtainedAt) ? obtainedAt : 0,
  };
}
