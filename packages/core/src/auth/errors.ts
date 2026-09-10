import type { OAuthClientConfig, TokenSet, TokenSummary } from "./types.js";

/**
 * Why a token could not be produced.
 *
 * The distinction that matters most to a host is `authorization_required`
 * (a human must complete a browser flow) versus everything else (retry, fix
 * config, or report). Hosts should branch on `code`, never on message text.
 */
export type OAuthErrorCode =
  /** No credentials, or the refresh token was rejected/revoked. Re-authorize. */
  | "authorization_required"
  /** The refresh grant failed for a transient or server-side reason. */
  | "refresh_failed"
  /** A non-refresh token request (code exchange, client credentials) failed. */
  | "token_request_failed"
  /** The config cannot support the requested grant. */
  | "invalid_configuration"
  /** The token endpoint was unreachable or returned an unusable body. */
  | "network_error"
  /** An authorization callback did not echo the expected `state`. */
  | "state_mismatch";

/** The placeholder substituted for every secret this module renders. */
export const REDACTED = "[redacted]";

/**
 * Error raised by the OAuth client.
 *
 * Messages are assembled from an allow-list of provider fields (`error`,
 * `error_description`) rather than from raw response bodies, because a token
 * endpoint is exactly the place where an echoed body could contain a
 * credential. `redactSecrets` is applied as a second, belt-and-braces pass.
 */
export class OAuthError extends Error {
  readonly code: OAuthErrorCode;
  readonly serverId: string;
  /** HTTP status of the failing token request, when there was one. */
  readonly status?: number;
  /** Machine-readable `error` field from an RFC 6749 error response. */
  readonly oauthError?: string;
  /** True when a bare retry could plausibly succeed. */
  readonly retryable: boolean;

  constructor(
    code: OAuthErrorCode,
    serverId: string,
    message: string,
    options: { status?: number; oauthError?: string; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(
      `[${serverId}] ${message}`,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "OAuthError";
    this.code = code;
    this.serverId = serverId;
    this.status = options.status;
    this.oauthError = options.oauthError;
    this.retryable = options.retryable ?? (code === "network_error" || code === "refresh_failed");
  }

  /** True when the host should start an interactive authorization. */
  get requiresAuthorization(): boolean {
    return this.code === "authorization_required";
  }
}

/**
 * Replaces known secret values wherever they appear in a string.
 *
 * Used on anything derived from a provider response before it reaches an error
 * message. Values shorter than 8 characters are skipped: they are not
 * plausible credentials and blindly replacing short strings would corrupt
 * ordinary text.
 */
export function redactSecrets(text: string, secrets: ReadonlyArray<string | undefined>): string {
  let out = text;
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length < 8) continue;
    out = out.split(secret).join(REDACTED);
  }
  return out;
}

/**
 * Secret-free projection of a config, for diagnostics and `doctor` output.
 *
 * Client ids are public by specification and are kept; secrets are replaced
 * with a fixed placeholder so the shape stays readable without the value ever
 * being renderable.
 */
export function redactOAuthConfig(config: OAuthClientConfig): Record<string, unknown> {
  const redacted: Record<string, unknown> = {
    type: config.type,
    grantType: config.grantType ?? "authorization_code",
    tokenUrl: config.tokenUrl,
    clientId: config.clientId,
    scopes: config.scopes ?? [],
  };
  if (config.authorizationUrl !== undefined) redacted["authorizationUrl"] = config.authorizationUrl;
  if (config.redirectUri !== undefined) redacted["redirectUri"] = config.redirectUri;
  if (config.resource !== undefined) redacted["resource"] = config.resource;
  if (config.audience !== undefined) redacted["audience"] = config.audience;
  if (config.clientSecret !== undefined || config.clientSecretEnv !== undefined) {
    redacted["clientSecret"] = REDACTED;
  }
  if (config.clientSecretEnv !== undefined) redacted["clientSecretEnv"] = config.clientSecretEnv;
  if (config.clientIdEnv !== undefined) redacted["clientIdEnv"] = config.clientIdEnv;
  return redacted;
}

/** Describes a token set without exposing either token. */
export function summarizeTokens(tokens: TokenSet | undefined): TokenSummary | undefined {
  if (!tokens) return undefined;
  return {
    hasAccessToken: tokens.accessToken.length > 0,
    hasRefreshToken: typeof tokens.refreshToken === "string" && tokens.refreshToken.length > 0,
    tokenType: tokens.tokenType,
    expiresAt: tokens.expiresAt === undefined ? undefined : new Date(tokens.expiresAt).toISOString(),
    scope: tokens.scope,
    obtainedAt: new Date(tokens.obtainedAt).toISOString(),
  };
}
