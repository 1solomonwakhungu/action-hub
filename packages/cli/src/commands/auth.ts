import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  FileTokenStore,
  OAuthClient,
  OAuthError,
  defaultCredentialsPath,
  resolveOAuthConfigSecrets,
} from "@action-hub/core";
import type { OAuthClientConfig, ServerConfig } from "@action-hub/core";
import { loadCliConfig } from "../config-loader.js";

export type AuthAction = "login" | "status" | "logout";

export interface AuthOptions {
  configPath?: string;
  /** Print the authorization URL instead of launching a browser. */
  noBrowser?: boolean;
  /** Seconds to wait for the authorization callback. Defaults to 300. */
  timeoutSeconds?: number;
}

const DEFAULT_TIMEOUT_SECONDS = 300;

/**
 * `action-hub auth <login|status|logout> [server]`.
 *
 * The one interactive step in the whole feature. Everything after a successful
 * login — expiry, rotation, 401 recovery — happens inside the transport, which
 * is why this command has no "paste your token here" path: a token typed in by
 * hand cannot be refreshed, so offering it would quietly reintroduce the
 * problem this feature exists to remove.
 */
export async function authCommand(
  action: AuthAction,
  serverId: string | undefined,
  options: AuthOptions = {},
): Promise<number> {
  const config = await loadCliConfig(options.configPath);
  const store = new FileTokenStore({ onWarning: (m) => console.error(`  ⚠ ${m}`) });

  if (action === "status") {
    return statusAction(config.servers, store);
  }

  if (!serverId) {
    console.error(`Usage: action-hub auth ${action} <server-id>`);
    return 1;
  }

  const server = config.servers.find((candidate) => candidate.id === serverId);
  if (!server) {
    console.error(`Unknown server "${serverId}". Run \`action-hub auth status\` to list servers.`);
    return 1;
  }

  if (action === "logout") {
    await store.delete(serverId);
    console.log(`Cleared stored credentials for "${serverId}".`);
    return 0;
  }

  return loginAction(server, store, options);
}

async function statusAction(
  servers: readonly ServerConfig[],
  store: FileTokenStore,
): Promise<number> {
  const oauthServers = servers.filter((server) => oauthConfigOf(server) !== undefined);

  console.log("OAuth 2.0 server status\n");
  console.log(`  Credential store: ${defaultCredentialsPath()}\n`);

  if (oauthServers.length === 0) {
    console.log("  No servers are configured with an `auth` block.");
    return 0;
  }

  for (const server of oauthServers) {
    const auth = oauthConfigOf(server) as OAuthClientConfig;
    const suffix = server.enabled === false ? " (server disabled)" : "";
    let client: OAuthClient;
    try {
      client = new OAuthClient({
        serverId: server.id,
        config: resolveOAuthConfigSecrets(auth, process.env, server.id),
        store,
      });
    } catch (cause) {
      // An OAuthError already names the server, so prefixing again would
      // print the id twice.
      console.log(`  ✖ ${prefixed(server.id, describe(cause))}${suffix}`);
      continue;
    }

    const { state, tokens } = await client.describe();
    const icon = state === "authenticated" ? "✔" : state === "unauthenticated" ? "·" : "⚠";
    console.log(`  ${icon} [${server.id}] ${state} (${client.grantType})${suffix}`);
    if (tokens) {
      // Only the summary is ever printed; the token values are never read here.
      console.log(`      refresh token: ${tokens.hasRefreshToken ? "stored" : "none"}`);
      console.log(`      expires:       ${tokens.expiresAt ?? "no expiry reported"}`);
      if (tokens.scope) console.log(`      scope:         ${tokens.scope}`);
    } else if (state === "unauthenticated") {
      console.log(`      run \`action-hub auth login ${server.id}\``);
    }
  }

  return 0;
}

async function loginAction(
  server: ServerConfig,
  store: FileTokenStore,
  options: AuthOptions,
): Promise<number> {
  const auth = oauthConfigOf(server);
  if (!auth) {
    console.error(
      `Server "${server.id}" has no \`transport.auth\` block, so there is nothing to authorize.`,
    );
    return 1;
  }

  let client: OAuthClient;
  try {
    client = new OAuthClient({
      serverId: server.id,
      config: resolveOAuthConfigSecrets(auth, process.env, server.id),
      store,
      onWarning: (message) => console.error(`  ⚠ ${message}`),
    });
  } catch (cause) {
    console.error(describe(cause));
    return 1;
  }

  // A client-credentials server needs no browser: the grant authenticates the
  // client itself, so "logging in" is just proving the configured secret works.
  if (client.grantType === "client_credentials") {
    try {
      await client.getAccessToken({ forceRefresh: true });
      console.log(`Obtained an access token for "${server.id}" via client_credentials.`);
      return 0;
    } catch (cause) {
      console.error(describe(cause));
      return 1;
    }
  }

  const listener = await startCallbackListener(auth.redirectUri);
  try {
    const request = client.createAuthorizationRequest({ redirectUri: listener.redirectUri });

    console.log(`Authorizing "${server.id}"...\n`);
    console.log(`  ${request.url}\n`);

    if (options.noBrowser) {
      console.log("  Open the URL above to continue.");
    } else {
      openBrowser(request.url);
      console.log("  Opened your browser. Complete the sign-in there.");
    }

    const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
    const callback = await listener.waitForCallback(timeoutSeconds * 1000);

    if (callback.error) {
      console.error(`\n✖ Authorization denied: ${callback.error}`);
      return 1;
    }
    if (!callback.code) {
      console.error("\n✖ Authorization callback did not include a code.");
      return 1;
    }

    const summary = await client.exchangeAuthorizationCode({
      code: callback.code,
      codeVerifier: request.codeVerifier,
      redirectUri: listener.redirectUri,
      returnedState: callback.state,
      expectedState: request.state,
    });

    console.log(`\n✔ Authorized "${server.id}".`);
    console.log(`  refresh token: ${summary.hasRefreshToken ? "stored" : "none issued"}`);
    console.log(`  expires:       ${summary.expiresAt ?? "no expiry reported"}`);
    if (!summary.hasRefreshToken) {
      console.log(
        "  Note: this provider issued no refresh token, so the session ends when the access token expires.",
      );
    }
    return 0;
  } catch (cause) {
    console.error(`\n✖ ${describe(cause)}`);
    return 1;
  } finally {
    await listener.close();
  }
}

interface CallbackResult {
  code?: string;
  state?: string;
  error?: string;
}

interface CallbackListener {
  redirectUri: string;
  waitForCallback(timeoutMs: number): Promise<CallbackResult>;
  close(): Promise<void>;
}

/**
 * Loopback redirect receiver (RFC 8252 §7.3).
 *
 * Binding to `127.0.0.1` rather than `localhost` is deliberate: `localhost` can
 * resolve to an interface other than the loopback one, and the authorization
 * code must never leave the machine. The port comes from the configured
 * `redirectUri` when there is one, because providers match redirect URIs
 * exactly; otherwise the OS assigns an ephemeral port.
 */
async function startCallbackListener(configuredRedirectUri?: string): Promise<CallbackListener> {
  let path = "/callback";
  let port = 0;

  if (configuredRedirectUri) {
    const parsed = new URL(configuredRedirectUri);
    path = parsed.pathname;
    port = parsed.port ? Number.parseInt(parsed.port, 10) : 0;
  }

  let resolveCallback: ((result: CallbackResult) => void) | undefined;
  const received = new Promise<CallbackResult>((resolve) => {
    resolveCallback = resolve;
  });

  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    if (requestUrl.pathname !== path) {
      res.writeHead(404).end("Not found");
      return;
    }

    const result: CallbackResult = {
      code: requestUrl.searchParams.get("code") ?? undefined,
      state: requestUrl.searchParams.get("state") ?? undefined,
      error:
        requestUrl.searchParams.get("error_description") ??
        requestUrl.searchParams.get("error") ??
        undefined,
    };

    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      result.error
        ? "<html><body><h3>Authorization failed.</h3><p>You can close this tab and check the terminal.</p></body></html>"
        : "<html><body><h3>Authorization complete.</h3><p>You can close this tab and return to the terminal.</p></body></html>",
    );
    resolveCallback?.(result);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  const address = server.address() as AddressInfo;
  const redirectUri = configuredRedirectUri ?? `http://127.0.0.1:${address.port}${path}`;

  return {
    redirectUri,
    async waitForCallback(timeoutMs: number) {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out waiting for the authorization callback`)),
          timeoutMs,
        );
      });
      try {
        return await Promise.race([received, timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    close() {
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * Best-effort browser launch. The URL is always printed first, so a failure
 * here degrades into "copy this link" rather than a dead end.
 */
function openBrowser(url: string): void {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    const child = spawn(command, [url], {
      stdio: "ignore",
      detached: true,
      shell: process.platform === "win32",
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Printing the URL is the fallback, and it already happened.
  }
}

function oauthConfigOf(server: ServerConfig): OAuthClientConfig | undefined {
  return server.transport.type === "http" ? server.transport.auth : undefined;
}

function describe(cause: unknown): string {
  if (cause instanceof OAuthError) return `${cause.message} (${cause.code})`;
  return cause instanceof Error ? cause.message : String(cause);
}

/** Adds a `[server]` tag only when the message does not already carry one. */
function prefixed(serverId: string, message: string): string {
  return message.startsWith(`[${serverId}]`) ? message : `[${serverId}] ${message}`;
}
