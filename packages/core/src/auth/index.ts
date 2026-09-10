/**
 * OAuth 2.0 support for remote MCP transports.
 *
 * The boundary this module defends: core speaks the protocol and owns token
 * lifecycle; the host owns credential storage and any browser interaction.
 * Nothing here imports a keychain, opens a browser, or reads `process.env`.
 */
export { OAuthClient } from "./oauth-client.js";
export type { OAuthClientOptions } from "./oauth-client.js";
export { OAuthError, REDACTED, redactOAuthConfig, redactSecrets, summarizeTokens } from "./errors.js";
export type { OAuthErrorCode } from "./errors.js";
export { createAuthenticatedFetch, isAuthorizationRequired } from "./fetch.js";
export type { AuthenticatedFetchOptions } from "./fetch.js";
export { InMemoryTokenStore, coerceTokenSet } from "./token-store.js";
export { FileTokenStore, defaultCredentialsPath } from "./file-token-store.js";
export type { FileTokenStoreOptions } from "./file-token-store.js";
export { createHttpAuthBinding } from "./transport.js";
export type { HttpAuthBinding, HttpAuthBindingOptions } from "./transport.js";
export { createPkcePair, createStateValue } from "./pkce.js";
export type { PkcePair } from "./pkce.js";
export { isOAuthClientConfig, resolveOAuthConfigSecrets } from "./config.js";
export type {
  AuthorizationRequest,
  AuthState,
  ClientAuthMethod,
  FetchLike,
  OAuthClientConfig,
  OAuthGrantType,
  TokenSet,
  TokenStore,
  TokenSummary,
} from "./types.js";
