import { OAuthError } from "./errors.js";
import type { OAuthClient } from "./oauth-client.js";
import type { FetchLike } from "./types.js";

export interface AuthenticatedFetchOptions {
  client: OAuthClient;
  /** Underlying transport. Defaults to the global `fetch`. */
  fetch?: FetchLike;
  /**
   * How many times a 401 may trigger a forced refresh and replay. Defaults to
   * 1. This bound is the whole point: a server that answers 401 to a
   * legitimately fresh token would otherwise put the client in a refresh loop
   * against the provider's rate limits.
   */
  maxUnauthorizedRetries?: number;
  /** Receives secret-free notes about retries. */
  onWarning?: (message: string) => void;
}

/**
 * Wraps a fetch so every request carries a valid OAuth access token.
 *
 * Two mechanisms, deliberately layered:
 *
 *  - **Proactive.** The token is fetched through {@link OAuthClient} before the
 *    request goes out, so an expiry that is already known about never costs a
 *    round trip.
 *  - **Reactive.** A 401 means the provider disagrees with our idea of
 *    validity — revoked early, clock skew, or rotated behind our back. The
 *    token is invalidated and the request replayed a bounded number of times.
 *
 * Replay only happens when the request body can be re-sent. A stream body is
 * consumed by the first attempt, so retrying it would send an empty request;
 * in that case the 401 is returned to the caller untouched and the (now
 * invalidated) token is refreshed on the next call instead.
 *
 * This is the seam the MCP SDK transports accept as their `fetch` option,
 * which is why the whole feature needs no fork of the SDK's own auth provider.
 */
export function createAuthenticatedFetch(options: AuthenticatedFetchOptions): FetchLike {
  const { client } = options;
  const baseFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const maxRetries = Math.max(0, options.maxUnauthorizedRetries ?? 1);
  const warn = options.onWarning ?? (() => {});

  return async function authenticatedFetch(url, init) {
    let attempt = 0;
    let forceRefresh = false;

    for (;;) {
      const auth = await client.getAuthorization({ forceRefresh });
      const headers = new Headers(init?.headers);
      headers.set(auth.headerName, auth.headerValue);

      const response = await baseFetch(url, { ...init, headers });

      if (response.status !== 401 || attempt >= maxRetries || !isReplayable(init?.body)) {
        return response;
      }

      // Discard the body so the connection is released before the replay.
      await response.body?.cancel().catch(() => {});

      attempt += 1;
      forceRefresh = true;
      warn(
        `server rejected the access token (401); refreshing and retrying (${attempt}/${maxRetries})`,
      );
      // Pass the token that actually failed so a refresh completed by a
      // concurrent request is not thrown away.
      await client.invalidateAccessToken(auth.accessToken);
    }
  };
}

/**
 * A body is replayable when it is a value we can hand to `fetch` twice.
 * Strings and byte views qualify; streams and one-shot sources do not.
 */
function isReplayable(body: RequestInit["body"]): boolean {
  if (body === undefined || body === null) return true;
  if (typeof body === "string") return true;
  if (body instanceof URLSearchParams) return true;
  if (ArrayBuffer.isView(body)) return true;
  if (body instanceof ArrayBuffer) return true;
  return false;
}

/** Narrowing helper for hosts that want to branch on an authorization prompt. */
export function isAuthorizationRequired(error: unknown): error is OAuthError {
  return error instanceof OAuthError && error.requiresAuthorization;
}
