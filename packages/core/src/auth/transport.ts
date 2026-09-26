import { resolveOAuthConfigSecrets } from "./config.js";
import { createAuthenticatedFetch } from "./fetch.js";
import { FileTokenStore } from "./file-token-store.js";
import { OAuthClient } from "./oauth-client.js";
import type { ServerConfig } from "../types.js";
import type { FetchLike, TokenStore } from "./types.js";

export interface HttpAuthBindingOptions {
  config: ServerConfig;
  /** Defaults to the shared mode-0600 credential file. */
  store?: TokenStore;
  /** Environment used to resolve `clientIdEnv` / `clientSecretEnv`. */
  env?: Record<string, string | undefined>;
  /** Underlying transport, for tests and proxy-aware hosts. */
  fetch?: FetchLike;
  /** Diagnostics sink. Never receives a token value. */
  onWarning?: (message: string) => void;
  /** 401 replay bound; see {@link createAuthenticatedFetch}. */
  maxUnauthorizedRetries?: number;
}

export interface HttpAuthBinding {
  /** Token lifecycle owner for this server. */
  client: OAuthClient;
  /** Fetch to hand to an MCP HTTP/SSE transport. */
  fetch: FetchLike;
}

/**
 * Builds the auth layer for one server, or nothing when it needs none.
 *
 * Both hosts — the CLI and the MCP server — construct MCP SDK
 * transports, and both need identical token handling. The SDK glue differs
 * between them; the OAuth wiring does not, so it lives here where it can be
 * tested without an SDK, a socket, or a browser.
 *
 * Returns `undefined` for stdio transports and for HTTP transports with no
 * `auth` block. That is what keeps static `Authorization` headers working
 * exactly as they did: no `auth`, no wrapper, no behaviour change.
 */
export function createHttpAuthBinding(
  options: HttpAuthBindingOptions,
): HttpAuthBinding | undefined {
  const { config } = options;
  if (config.transport.type !== "http") return undefined;

  const auth = config.transport.auth;
  if (!auth) return undefined;

  const warn = options.onWarning ?? (() => {});
  const client = new OAuthClient({
    serverId: config.id,
    config: resolveOAuthConfigSecrets(auth, options.env ?? {}, config.id),
    store: options.store ?? new FileTokenStore({ onWarning: warn }),
    fetch: options.fetch,
    onWarning: warn,
  });

  return {
    client,
    fetch: createAuthenticatedFetch({
      client,
      fetch: options.fetch,
      maxUnauthorizedRetries: options.maxUnauthorizedRetries,
      onWarning: warn,
    }),
  };
}
