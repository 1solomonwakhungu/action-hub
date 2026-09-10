/**
 * OAuth 2.0 domain types for remote (HTTP/SSE) MCP servers.
 *
 * Everything here is runtime-agnostic on purpose. Core knows how to *speak*
 * OAuth 2.0 — it does not know where credentials live. Persistence is supplied
 * by the host through {@link TokenStore}, so a CLI can back it with a
 * mode-0600 file, a desktop app with a platform keychain, and a test with a
 * map, without core growing a dependency on any of them.
 */

/** Minimal structural fetch, matching the MCP SDK's `FetchLike`. */
export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * Grants Action Hub can complete on its own behalf.
 *
 * `authorization_code` requires a one-time interactive step; everything after
 * that (expiry, rotation, 401 recovery) is automatic. `client_credentials`
 * needs no human at all.
 */
export type OAuthGrantType = "authorization_code" | "client_credentials";

/** How the client authenticates itself at the token endpoint (RFC 6749 §2.3). */
export type ClientAuthMethod = "client_secret_basic" | "client_secret_post" | "none";

/**
 * Declarative description of an authorization server.
 *
 * GitHub, Slack, Jira, and any other standards-compliant provider are modelled
 * by filling this in — there is deliberately no provider registry and no
 * per-vendor branching anywhere in this module. If a provider needs an extra
 * token or authorization parameter, it goes in `extraTokenParams` /
 * `extraAuthorizationParams` rather than into code.
 */
export interface OAuthClientConfig {
  type: "oauth2";
  /** Defaults to `authorization_code`. */
  grantType?: OAuthGrantType;
  /** Token endpoint. Required for every grant. */
  tokenUrl: string;
  /** Authorization endpoint. Required for `authorization_code`. */
  authorizationUrl?: string;
  clientId: string;
  /**
   * Public clients (PKCE, no secret) omit this. Prefer `clientSecretEnv` in
   * checked-in config so the value never lands in a config file.
   */
  clientSecret?: string;
  /** Environment variable holding the client secret; resolved by the host. */
  clientSecretEnv?: string;
  /** Environment variable holding the client id; resolved by the host. */
  clientIdEnv?: string;
  scopes?: string[];
  /** Redirect URI for `authorization_code`. Must match the provider registration. */
  redirectUri?: string;
  /** RFC 8707 resource indicator, sent as `resource` when set. */
  resource?: string;
  /** Sent as `audience`; used by Auth0-style providers. */
  audience?: string;
  /**
   * PKCE (RFC 7636). Defaults to `true` for `authorization_code`; only turn it
   * off for a provider that rejects the challenge outright.
   */
  usePkce?: boolean;
  /**
   * Defaults to `client_secret_basic` when a secret is present and `none`
   * otherwise.
   */
  clientAuthMethod?: ClientAuthMethod;
  /** Extra form fields added to every token request. */
  extraTokenParams?: Record<string, string>;
  /** Extra query parameters added to the authorization URL. */
  extraAuthorizationParams?: Record<string, string>;
  /**
   * How early, in seconds, a token counts as expired. Refreshing slightly
   * ahead of the real deadline avoids losing a race with a request already in
   * flight. Defaults to 60.
   */
  refreshLeewaySeconds?: number;
  /** Header carrying the token. Defaults to `Authorization`. */
  headerName?: string;
  /** Scheme prefix. Defaults to `Bearer`; set to `""` to send the bare token. */
  headerScheme?: string;
}

/**
 * A credential set as held in memory and handed to a {@link TokenStore}.
 *
 * `accessToken` and `refreshToken` are secrets. Nothing in core writes this
 * object to a log, an error message, a snapshot, or the catalog cache — use
 * {@link TokenSummary} when a token needs to be *described*.
 */
export interface TokenSet {
  accessToken: string;
  /** Normalised to `Bearer` when the provider omits it. */
  tokenType: string;
  /** Epoch milliseconds. Absent means the provider declared no expiry. */
  expiresAt?: number;
  /** Present when the provider issued one; replaced on rotation. */
  refreshToken?: string;
  /** Space-delimited granted scopes, as returned by the provider. */
  scope?: string;
  /** Epoch milliseconds the set was issued at. */
  obtainedAt: number;
}

/** Secret-free view of a {@link TokenSet}, safe for logs and diagnostics. */
export interface TokenSummary {
  hasAccessToken: boolean;
  hasRefreshToken: boolean;
  tokenType: string;
  expiresAt?: string;
  scope?: string;
  obtainedAt: string;
}

/**
 * Where a server stands with its authorization server.
 *
 * This is surfaced verbatim so a host can tell "nobody has ever logged in"
 * apart from "the refresh token was revoked" — the two need very different
 * prompts.
 */
export type AuthState =
  /** No credentials stored; an interactive authorization is required. */
  | "unauthenticated"
  /** A usable access token is held. */
  | "authenticated"
  /** Credentials exist but the access token is past its expiry. */
  | "expired"
  /** A refresh or token request is in flight. */
  | "refreshing"
  /** The last token request failed for a reason other than expiry. */
  | "error";

/**
 * Host-supplied credential persistence.
 *
 * Implementations may be async or sync. Keys are opaque strings scoped by the
 * caller (Action Hub uses the server id), so a single store can back every
 * configured server.
 */
export interface TokenStore {
  get(key: string): Promise<TokenSet | undefined> | TokenSet | undefined;
  set(key: string, tokens: TokenSet): Promise<void> | void;
  delete(key: string): Promise<void> | void;
}

/** One pending authorization-code request, returned to the host to drive a browser. */
export interface AuthorizationRequest {
  /** Fully-formed authorization endpoint URL to open. */
  url: string;
  /** CSRF value; the callback must echo it back. */
  state: string;
  /** PKCE verifier to replay at the token endpoint. Absent when PKCE is off. */
  codeVerifier?: string;
  redirectUri: string;
}
