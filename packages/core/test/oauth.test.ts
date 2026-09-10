import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  FileTokenStore,
  InMemoryTokenStore,
  OAuthClient,
  OAuthError,
  REDACTED,
  coerceTokenSet,
  createAuthenticatedFetch,
  createHttpAuthBinding,
  isAuthorizationRequired,
  isOAuthClientConfig,
  redactOAuthConfig,
  redactSecrets,
  resolveOAuthConfigSecrets,
  summarizeTokens,
} from "../dist/auth/index.js";
import { hashServerConfigs } from "../dist/catalog/persistence.js";
import type { OAuthClientConfig, TokenSet } from "../dist/auth/types.js";
import type { ServerConfig } from "../dist/types.js";

const TOKEN_URL = "https://provider.example/oauth/token";

function baseConfig(overrides: Partial<OAuthClientConfig> = {}): OAuthClientConfig {
  return {
    type: "oauth2",
    tokenUrl: TOKEN_URL,
    authorizationUrl: "https://provider.example/oauth/authorize",
    clientId: "client-abc",
    scopes: ["repo", "read:org"],
    redirectUri: "http://127.0.0.1:7788/callback",
    ...overrides,
  };
}

/** Records every token request and replays scripted responses in order. */
function tokenEndpoint(responses: Array<{ status?: number; body: unknown; delayMs?: number }>) {
  const requests: Array<{ url: string; params: URLSearchParams; headers: Headers }> = [];
  let index = 0;

  const fetchImpl = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const scripted = responses[Math.min(index, responses.length - 1)];
    index += 1;
    requests.push({
      url: String(url),
      params: new URLSearchParams(String(init?.body ?? "")),
      headers: new Headers(init?.headers),
    });
    if (scripted?.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, scripted.delayMs));
    }
    return new Response(JSON.stringify(scripted?.body ?? {}), {
      status: scripted?.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };

  return { fetch: fetchImpl, requests, get callCount() { return requests.length; } };
}

function storedTokens(overrides: Partial<TokenSet> = {}): TokenSet {
  return {
    accessToken: "access-original",
    tokenType: "Bearer",
    expiresAt: Date.now() + 3_600_000,
    refreshToken: "refresh-original",
    obtainedAt: Date.now(),
    ...overrides,
  };
}

test("a valid access token is reused without contacting the token endpoint", async () => {
  const endpoint = tokenEndpoint([{ body: { access_token: "should-not-be-used" } }]);
  const store = new InMemoryTokenStore();
  store.set("srv", storedTokens());

  const client = new OAuthClient({
    serverId: "srv",
    config: baseConfig(),
    store,
    fetch: endpoint.fetch,
  });

  assert.equal(await client.getAccessToken(), "access-original");
  assert.equal(endpoint.callCount, 0, "a live token must not trigger a refresh");
  assert.equal(client.state(), "authenticated");
});

test("expiry leeway refreshes before the deadline rather than after a failure", async () => {
  const now = Date.now();
  const endpoint = tokenEndpoint([
    { body: { access_token: "access-refreshed", expires_in: 3600 } },
  ]);
  const store = new InMemoryTokenStore();
  // 30s of life left, but the default 60s leeway treats it as already expired.
  store.set("srv", storedTokens({ expiresAt: now + 30_000 }));

  const client = new OAuthClient({
    serverId: "srv",
    config: baseConfig(),
    store,
    fetch: endpoint.fetch,
    now: () => now,
  });

  assert.equal(await client.getAccessToken(), "access-refreshed");
  assert.equal(endpoint.callCount, 1);
  assert.equal(endpoint.requests[0]?.params.get("grant_type"), "refresh_token");

  // A shorter leeway leaves the same token usable.
  const patient = new OAuthClient({
    serverId: "srv2",
    config: baseConfig({ refreshLeewaySeconds: 5 }),
    store: (() => {
      const s = new InMemoryTokenStore();
      s.set("srv2", storedTokens({ expiresAt: now + 30_000 }));
      return s;
    })(),
    fetch: endpoint.fetch,
    now: () => now,
  });
  assert.equal(await patient.getAccessToken(), "access-original");
  assert.equal(endpoint.callCount, 1, "no additional token request");
});

test("a token with no declared expiry is treated as valid", async () => {
  const endpoint = tokenEndpoint([{ body: { access_token: "unused" } }]);
  const store = new InMemoryTokenStore();
  store.set("srv", storedTokens({ expiresAt: undefined }));

  const client = new OAuthClient({
    serverId: "srv",
    config: baseConfig(),
    store,
    fetch: endpoint.fetch,
  });

  assert.equal(await client.getAccessToken(), "access-original");
  assert.equal(endpoint.callCount, 0);
});

test("concurrent callers share a single refresh", async () => {
  const endpoint = tokenEndpoint([
    { body: { access_token: "access-refreshed", expires_in: 3600 }, delayMs: 25 },
  ]);
  const store = new InMemoryTokenStore();
  store.set("srv", storedTokens({ expiresAt: Date.now() - 1 }));

  const client = new OAuthClient({
    serverId: "srv",
    config: baseConfig(),
    store,
    fetch: endpoint.fetch,
  });

  const tokens = await Promise.all(
    Array.from({ length: 8 }, () => client.getAccessToken()),
  );

  assert.deepEqual(new Set(tokens), new Set(["access-refreshed"]));
  assert.equal(
    endpoint.callCount,
    1,
    "eight concurrent callers must produce exactly one token request",
  );
});

test("a refresh that fails rejects every joined caller and leaves the slot reusable", async () => {
  const endpoint = tokenEndpoint([
    { status: 503, body: { error: "temporarily_unavailable" }, delayMs: 10 },
    { body: { access_token: "access-eventual", expires_in: 3600 } },
  ]);
  const store = new InMemoryTokenStore();
  store.set("srv", storedTokens({ expiresAt: Date.now() - 1 }));

  const client = new OAuthClient({
    serverId: "srv",
    config: baseConfig(),
    store,
    fetch: endpoint.fetch,
  });

  const results = await Promise.allSettled([client.getAccessToken(), client.getAccessToken()]);
  assert.equal(results.filter((r) => r.status === "rejected").length, 2);
  assert.equal(endpoint.callCount, 1, "the failure is shared, not repeated");

  const failure = (results[0] as PromiseRejectedResult).reason as OAuthError;
  assert.equal(failure.code, "refresh_failed");
  assert.equal(failure.retryable, true, "a 5xx refresh failure is worth retrying");
  assert.equal(client.state(), "error");

  // The single-flight slot must have been released, so a later call retries.
  assert.equal(await client.getAccessToken(), "access-eventual");
  assert.equal(endpoint.callCount, 2);
});

test("a rotated refresh token replaces the stored one", async () => {
  const endpoint = tokenEndpoint([
    {
      body: {
        access_token: "access-1",
        refresh_token: "refresh-rotated",
        expires_in: 3600,
      },
    },
  ]);
  const store = new InMemoryTokenStore();
  store.set("srv", storedTokens({ expiresAt: Date.now() - 1 }));

  const client = new OAuthClient({
    serverId: "srv",
    config: baseConfig(),
    store,
    fetch: endpoint.fetch,
  });

  await client.getAccessToken();
  assert.equal(endpoint.requests[0]?.params.get("refresh_token"), "refresh-original");
  assert.equal(store.get("srv")?.refreshToken, "refresh-rotated");
  assert.equal(store.get("srv")?.accessToken, "access-1");
});

test("a provider that does not rotate keeps the existing refresh token", async () => {
  const endpoint = tokenEndpoint([{ body: { access_token: "access-1", expires_in: 3600 } }]);
  const store = new InMemoryTokenStore();
  store.set("srv", storedTokens({ expiresAt: Date.now() - 1, scope: "repo" }));

  const client = new OAuthClient({
    serverId: "srv",
    config: baseConfig(),
    store,
    fetch: endpoint.fetch,
  });

  await client.getAccessToken();
  assert.equal(
    store.get("srv")?.refreshToken,
    "refresh-original",
    "dropping it would silently downgrade a renewable credential",
  );
  assert.equal(store.get("srv")?.scope, "repo", "the previous scope is carried forward");
});

test("invalid_grant clears the credential and demands re-authorization", async () => {
  const endpoint = tokenEndpoint([
    { status: 400, body: { error: "invalid_grant", error_description: "token revoked" } },
  ]);
  const store = new InMemoryTokenStore();
  store.set("srv", storedTokens({ expiresAt: Date.now() - 1 }));

  const client = new OAuthClient({
    serverId: "srv",
    config: baseConfig(),
    store,
    fetch: endpoint.fetch,
  });

  const error = await client.getAccessToken().then(
    () => undefined,
    (cause: unknown) => cause as OAuthError,
  );

  assert.ok(error instanceof OAuthError);
  assert.equal(error.code, "authorization_required");
  assert.equal(error.retryable, false);
  assert.ok(isAuthorizationRequired(error));
  assert.equal(store.get("srv"), undefined, "a revoked grant must not be kept");
  assert.equal(client.state(), "unauthenticated");
});

test("no stored credential produces an explicit authorization_required error", async () => {
  const endpoint = tokenEndpoint([{ body: {} }]);
  const client = new OAuthClient({
    serverId: "srv",
    config: baseConfig(),
    store: new InMemoryTokenStore(),
    fetch: endpoint.fetch,
  });

  const error = await client.getAccessToken().then(
    () => undefined,
    (cause: unknown) => cause as OAuthError,
  );

  assert.equal(error?.code, "authorization_required");
  assert.equal(endpoint.callCount, 0, "there is nothing to send without a credential");
});

test("an expired token with no refresh token requires re-authorization", async () => {
  const endpoint = tokenEndpoint([{ body: {} }]);
  const store = new InMemoryTokenStore();
  store.set("srv", storedTokens({ expiresAt: Date.now() - 1, refreshToken: undefined }));

  const client = new OAuthClient({
    serverId: "srv",
    config: baseConfig(),
    store,
    fetch: endpoint.fetch,
  });

  const error = await client.getAccessToken().then(
    () => undefined,
    (cause: unknown) => cause as OAuthError,
  );
  assert.equal(error?.code, "authorization_required");
  assert.equal(endpoint.callCount, 0);
});

test("the client_credentials grant mints a token with no stored credential", async () => {
  const endpoint = tokenEndpoint([{ body: { access_token: "access-cc", expires_in: 60 } }]);
  const client = new OAuthClient({
    serverId: "srv",
    config: baseConfig({ grantType: "client_credentials", clientSecret: "s3cret-value-long" }),
    store: new InMemoryTokenStore(),
    fetch: endpoint.fetch,
  });

  assert.equal(await client.getAccessToken(), "access-cc");
  assert.equal(endpoint.requests[0]?.params.get("grant_type"), "client_credentials");
  assert.equal(
    endpoint.requests[0]?.headers.get("authorization"),
    `Basic ${Buffer.from("client-abc:s3cret-value-long", "utf8").toString("base64")}`,
    "a secret defaults to client_secret_basic",
  );
});

test("client_secret_post sends credentials in the body instead of a header", async () => {
  const endpoint = tokenEndpoint([{ body: { access_token: "access-cc" } }]);
  const client = new OAuthClient({
    serverId: "srv",
    config: baseConfig({
      grantType: "client_credentials",
      clientSecret: "s3cret-value-long",
      clientAuthMethod: "client_secret_post",
    }),
    store: new InMemoryTokenStore(),
    fetch: endpoint.fetch,
  });

  await client.getAccessToken();
  assert.equal(endpoint.requests[0]?.headers.get("authorization"), null);
  assert.equal(endpoint.requests[0]?.params.get("client_secret"), "s3cret-value-long");
  assert.equal(endpoint.requests[0]?.params.get("client_id"), "client-abc");
});

test("client_credentials without a secret is rejected as a configuration error", () => {
  assert.throws(
    () =>
      new OAuthClient({
        serverId: "srv",
        config: baseConfig({ grantType: "client_credentials" }),
        store: new InMemoryTokenStore(),
      }),
    (error: unknown) => error instanceof OAuthError && error.code === "invalid_configuration",
  );
});

test("the authorization URL carries PKCE, scope, and state", () => {
  const client = new OAuthClient({
    serverId: "srv",
    config: baseConfig({ extraAuthorizationParams: { prompt: "consent" } }),
    store: new InMemoryTokenStore(),
  });

  const request = client.createAuthorizationRequest();
  const url = new URL(request.url);

  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), "client-abc");
  assert.equal(url.searchParams.get("scope"), "repo read:org");
  assert.equal(url.searchParams.get("state"), request.state);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("prompt"), "consent");
  assert.ok(request.codeVerifier && request.codeVerifier.length >= 43);
  assert.notEqual(
    url.searchParams.get("code_challenge"),
    request.codeVerifier,
    "S256 must send a hash, never the verifier",
  );

  // Each request gets fresh one-time values so two logins cannot collide.
  assert.notEqual(client.createAuthorizationRequest().state, request.state);
});

test("a mismatched callback state is refused before the code is exchanged", async () => {
  const endpoint = tokenEndpoint([{ body: { access_token: "should-not-be-issued" } }]);
  const client = new OAuthClient({
    serverId: "srv",
    config: baseConfig(),
    store: new InMemoryTokenStore(),
    fetch: endpoint.fetch,
  });

  await assert.rejects(
    client.exchangeAuthorizationCode({
      code: "abc",
      redirectUri: "http://127.0.0.1:7788/callback",
      expectedState: "expected",
      returnedState: "attacker",
    }),
    (error: unknown) => error instanceof OAuthError && error.code === "state_mismatch",
  );
  assert.equal(endpoint.callCount, 0);
});

test("an authorization code is exchanged and stored with its verifier", async () => {
  const endpoint = tokenEndpoint([
    {
      body: {
        access_token: "access-new",
        refresh_token: "refresh-new",
        expires_in: 7200,
        scope: "repo",
      },
    },
  ]);
  const store = new InMemoryTokenStore();
  const client = new OAuthClient({
    serverId: "srv",
    config: baseConfig(),
    store,
    fetch: endpoint.fetch,
  });

  const summary = await client.exchangeAuthorizationCode({
    code: "auth-code",
    codeVerifier: "verifier-value",
    redirectUri: "http://127.0.0.1:7788/callback",
  });

  assert.equal(endpoint.requests[0]?.params.get("grant_type"), "authorization_code");
  assert.equal(endpoint.requests[0]?.params.get("code_verifier"), "verifier-value");
  assert.equal(store.get("srv")?.refreshToken, "refresh-new");
  assert.equal(summary.hasRefreshToken, true);
  assert.equal(await client.getAccessToken(), "access-new");
});

// ---------------------------------------------------------------------------
// Authenticated fetch: 401 handling and retry bounds
// ---------------------------------------------------------------------------

test("a 401 triggers one forced refresh and one replay", async () => {
  const endpoint = tokenEndpoint([
    { body: { access_token: "access-stale", expires_in: 3600 } },
    { body: { access_token: "access-fresh", expires_in: 3600 } },
  ]);
  const store = new InMemoryTokenStore();
  store.set("srv", storedTokens({ expiresAt: Date.now() - 1 }));

  const client = new OAuthClient({
    serverId: "srv",
    config: baseConfig(),
    store,
    fetch: endpoint.fetch,
  });

  const seen: Array<string | null> = [];
  const authed = createAuthenticatedFetch({
    client,
    fetch: async (_url, init) => {
      const auth = new Headers(init?.headers).get("authorization");
      seen.push(auth);
      return new Response("", { status: auth === "Bearer access-fresh" ? 200 : 401 });
    },
  });

  const response = await authed("https://mcp.example/rpc", { method: "POST", body: "{}" });

  assert.equal(response.status, 200);
  assert.deepEqual(seen, ["Bearer access-stale", "Bearer access-fresh"]);
  assert.equal(endpoint.callCount, 2, "the 401 forces exactly one extra token request");
});

test("repeated 401s stop at the retry bound instead of looping", async () => {
  const endpoint = tokenEndpoint([{ body: { access_token: "access-any", expires_in: 3600 } }]);
  const store = new InMemoryTokenStore();
  store.set("srv", storedTokens({ expiresAt: Date.now() - 1 }));

  const client = new OAuthClient({
    serverId: "srv",
    config: baseConfig(),
    store,
    fetch: endpoint.fetch,
  });

  let attempts = 0;
  const authed = createAuthenticatedFetch({
    client,
    fetch: async () => {
      attempts += 1;
      return new Response("", { status: 401 });
    },
  });

  const response = await authed("https://mcp.example/rpc", { method: "POST", body: "{}" });

  assert.equal(response.status, 401, "the caller sees the 401 rather than an infinite retry");
  assert.equal(attempts, 2, "one original attempt plus the single default retry");
  assert.equal(endpoint.callCount, 2);
});

test("the retry bound is configurable down to zero", async () => {
  const endpoint = tokenEndpoint([{ body: { access_token: "access-any", expires_in: 3600 } }]);
  const store = new InMemoryTokenStore();
  store.set("srv", storedTokens({ expiresAt: Date.now() - 1 }));

  const client = new OAuthClient({
    serverId: "srv",
    config: baseConfig(),
    store,
    fetch: endpoint.fetch,
  });

  let attempts = 0;
  const authed = createAuthenticatedFetch({
    client,
    maxUnauthorizedRetries: 0,
    fetch: async () => {
      attempts += 1;
      return new Response("", { status: 401 });
    },
  });

  assert.equal((await authed("https://mcp.example/rpc")).status, 401);
  assert.equal(attempts, 1);
});

test("a non-401 response is returned untouched", async () => {
  const endpoint = tokenEndpoint([{ body: { access_token: "access-any", expires_in: 3600 } }]);
  const store = new InMemoryTokenStore();
  store.set("srv", storedTokens({ expiresAt: Date.now() - 1 }));

  const client = new OAuthClient({
    serverId: "srv",
    config: baseConfig(),
    store,
    fetch: endpoint.fetch,
  });

  let attempts = 0;
  const authed = createAuthenticatedFetch({
    client,
    fetch: async () => {
      attempts += 1;
      return new Response("nope", { status: 403 });
    },
  });

  assert.equal((await authed("https://mcp.example/rpc")).status, 403);
  assert.equal(attempts, 1, "a 403 is an authorization decision, not a stale token");
});

test("caller headers survive; the OAuth header wins over a static one", async () => {
  const endpoint = tokenEndpoint([{ body: { access_token: "access-any", expires_in: 3600 } }]);
  const store = new InMemoryTokenStore();
  store.set("srv", storedTokens({ expiresAt: Date.now() - 1 }));

  const client = new OAuthClient({
    serverId: "srv",
    config: baseConfig(),
    store,
    fetch: endpoint.fetch,
  });

  let captured: Headers | undefined;
  const authed = createAuthenticatedFetch({
    client,
    fetch: async (_url, init) => {
      captured = new Headers(init?.headers);
      return new Response("{}", { status: 200 });
    },
  });

  await authed("https://mcp.example/rpc", {
    headers: { "x-trace": "abc", authorization: "Bearer hand-written-stale" },
  });

  assert.equal(captured?.get("x-trace"), "abc");
  assert.equal(captured?.get("authorization"), "Bearer access-any");
});

test("a stream body is not replayed, because a replay would send nothing", async () => {
  const endpoint = tokenEndpoint([{ body: { access_token: "access-any", expires_in: 3600 } }]);
  const store = new InMemoryTokenStore();
  store.set("srv", storedTokens({ expiresAt: Date.now() - 1 }));

  const client = new OAuthClient({
    serverId: "srv",
    config: baseConfig(),
    store,
    fetch: endpoint.fetch,
  });

  let attempts = 0;
  const authed = createAuthenticatedFetch({
    client,
    fetch: async () => {
      attempts += 1;
      return new Response("", { status: 401 });
    },
  });

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{}"));
      controller.close();
    },
  });

  const response = await authed("https://mcp.example/rpc", {
    method: "POST",
    body,
    // @ts-expect-error duplex is required by undici for stream bodies
    duplex: "half",
  });

  assert.equal(response.status, 401);
  assert.equal(attempts, 1);
});

test("a custom header name and empty scheme send the bare token", async () => {
  const endpoint = tokenEndpoint([{ body: { access_token: "access-any", expires_in: 3600 } }]);
  const store = new InMemoryTokenStore();
  store.set("srv", storedTokens({ expiresAt: Date.now() - 1 }));

  const client = new OAuthClient({
    serverId: "srv",
    config: baseConfig({ headerName: "x-api-token", headerScheme: "" }),
    store,
    fetch: endpoint.fetch,
  });

  let captured: Headers | undefined;
  const authed = createAuthenticatedFetch({
    client,
    fetch: async (_url, init) => {
      captured = new Headers(init?.headers);
      return new Response("{}", { status: 200 });
    },
  });

  await authed("https://mcp.example/rpc");
  assert.equal(captured?.get("x-api-token"), "access-any");
  assert.equal(captured?.get("authorization"), null);
});

test("a 401 on an already-replaced token does not discard the fresh one", async () => {
  const endpoint = tokenEndpoint([{ body: { access_token: "access-any", expires_in: 3600 } }]);
  const store = new InMemoryTokenStore();
  store.set("srv", storedTokens());

  const client = new OAuthClient({
    serverId: "srv",
    config: baseConfig(),
    store,
    fetch: endpoint.fetch,
  });

  await client.getAccessToken();
  // A slow request that failed on a token replaced in the meantime.
  await client.invalidateAccessToken("some-other-older-token");

  assert.equal(await client.getAccessToken(), "access-original");
  assert.equal(endpoint.callCount, 0, "the live token must survive a mismatched invalidation");
});

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

test("a client secret never reaches an error message", async () => {
  const secret = "super-secret-client-value";
  const endpoint = tokenEndpoint([
    {
      status: 400,
      body: {
        error: "invalid_client",
        // A provider that echoes the credential back must not leak it onwards.
        error_description: `bad credentials for ${secret}`,
      },
    },
  ]);

  const client = new OAuthClient({
    serverId: "srv",
    config: baseConfig({ grantType: "client_credentials", clientSecret: secret }),
    store: new InMemoryTokenStore(),
    fetch: endpoint.fetch,
  });

  const error = await client.getAccessToken().then(
    () => undefined,
    (cause: unknown) => cause as OAuthError,
  );

  assert.ok(error instanceof OAuthError);
  assert.ok(!error.message.includes(secret), "the secret must be scrubbed");
  assert.ok(error.message.includes(REDACTED));
  assert.equal(error.oauthError, "invalid_client");
});

test("a token endpoint body is never echoed verbatim", async () => {
  const endpoint = tokenEndpoint([
    {
      status: 400,
      body: {
        error: "invalid_request",
        access_token: "leaked-access-token-value",
        refresh_token: "leaked-refresh-token-value",
      },
    },
  ]);
  const store = new InMemoryTokenStore();
  store.set("srv", storedTokens({ expiresAt: Date.now() - 1 }));

  const client = new OAuthClient({
    serverId: "srv",
    config: baseConfig(),
    store,
    fetch: endpoint.fetch,
  });

  const error = await client.getAccessToken().then(
    () => undefined,
    (cause: unknown) => cause as Error,
  );

  assert.ok(error);
  assert.ok(!error.message.includes("leaked-access-token-value"));
  assert.ok(!error.message.includes("leaked-refresh-token-value"));
  assert.ok(!error.message.includes("refresh-original"));
});

test("redactSecrets replaces credentials but leaves short strings alone", () => {
  assert.equal(redactSecrets("token=abcdefghij done", ["abcdefghij"]), `token=${REDACTED} done`);
  assert.equal(redactSecrets("a short word", ["short"]), "a short word");
  assert.equal(redactSecrets("nothing", [undefined]), "nothing");
});

test("redactOAuthConfig keeps the public shape and drops the secret", () => {
  const redacted = redactOAuthConfig(
    baseConfig({ clientSecret: "super-secret-value", clientSecretEnv: "GH_SECRET" }),
  );

  assert.equal(redacted["clientId"], "client-abc");
  assert.equal(redacted["tokenUrl"], TOKEN_URL);
  assert.equal(redacted["clientSecret"], REDACTED);
  assert.equal(redacted["clientSecretEnv"], "GH_SECRET");
  assert.ok(!JSON.stringify(redacted).includes("super-secret-value"));
});

test("token summaries describe a credential without exposing it", async () => {
  const summary = summarizeTokens(storedTokens());
  assert.equal(summary?.hasAccessToken, true);
  assert.equal(summary?.hasRefreshToken, true);
  assert.ok(!JSON.stringify(summary).includes("access-original"));
  assert.ok(!JSON.stringify(summary).includes("refresh-original"));

  const store = new InMemoryTokenStore();
  store.set("srv", storedTokens());
  const described = await new OAuthClient({
    serverId: "srv",
    config: baseConfig(),
    store,
  }).describe();
  assert.equal(described.state, "authenticated");
  assert.ok(!JSON.stringify(described).includes("access-original"));
});

test("the catalog config hash excludes OAuth secrets", () => {
  const withSecret = (clientSecret: string): ServerConfig => ({
    id: "remote",
    transport: {
      type: "http",
      url: "https://mcp.example/rpc",
      auth: { ...baseConfig(), clientSecret },
    },
  });

  assert.equal(
    hashServerConfigs([withSecret("secret-one-value")]),
    hashServerConfigs([withSecret("secret-two-value")]),
    "rotating a secret must not invalidate an otherwise-valid catalog",
  );

  const scoped: ServerConfig = {
    id: "remote",
    transport: {
      type: "http",
      url: "https://mcp.example/rpc",
      auth: { ...baseConfig(), scopes: ["repo"] },
    },
  };
  assert.notEqual(
    hashServerConfigs([withSecret("secret-one-value")]),
    hashServerConfigs([scoped]),
    "a scope change alters what the connection is and must re-index",
  );
});

// ---------------------------------------------------------------------------
// Config resolution and transport binding
// ---------------------------------------------------------------------------

test("environment references are resolved without appearing in config", () => {
  const resolved = resolveOAuthConfigSecrets(
    baseConfig({ clientId: "", clientIdEnv: "GH_ID", clientSecretEnv: "GH_SECRET" }),
    { GH_ID: "id-from-env", GH_SECRET: "secret-from-env" },
    "srv",
  );

  assert.equal(resolved.clientId, "id-from-env");
  assert.equal(resolved.clientSecret, "secret-from-env");

  assert.throws(
    () => resolveOAuthConfigSecrets(baseConfig({ clientId: "", clientIdEnv: "MISSING" }), {}, "srv"),
    (error: unknown) => error instanceof OAuthError && error.code === "invalid_configuration",
  );
});

test("a literal secret takes precedence over its environment reference", () => {
  const resolved = resolveOAuthConfigSecrets(
    baseConfig({ clientSecret: "literal-secret-value", clientSecretEnv: "GH_SECRET" }),
    { GH_SECRET: "env-secret-value" },
  );
  assert.equal(resolved.clientSecret, "literal-secret-value");
});

test("isOAuthClientConfig rejects malformed blocks from untrusted JSON", () => {
  assert.equal(isOAuthClientConfig(baseConfig()), true);
  assert.equal(isOAuthClientConfig({ type: "oauth2", tokenUrl: TOKEN_URL }), false);
  assert.equal(isOAuthClientConfig({ type: "basic", tokenUrl: TOKEN_URL, clientId: "x" }), false);
  assert.equal(
    isOAuthClientConfig({ type: "oauth2", tokenUrl: TOKEN_URL, clientId: "x", grantType: "implicit" }),
    false,
  );
  assert.equal(isOAuthClientConfig(null), false);
  assert.equal(isOAuthClientConfig([baseConfig()]), false);
});

test("transports without an auth block get no wrapper at all", () => {
  const stdio: ServerConfig = { id: "local", transport: { type: "stdio", command: "srv" } };
  const staticHeaders: ServerConfig = {
    id: "remote",
    transport: {
      type: "http",
      url: "https://mcp.example/rpc",
      headers: { Authorization: "Bearer static-pat" },
    },
  };

  assert.equal(createHttpAuthBinding({ config: stdio }), undefined);
  assert.equal(
    createHttpAuthBinding({ config: staticHeaders }),
    undefined,
    "static Bearer configuration must keep working untouched",
  );
});

test("an auth block produces a client bound to the server id", async () => {
  const endpoint = tokenEndpoint([{ body: { access_token: "access-bound", expires_in: 3600 } }]);
  const store = new InMemoryTokenStore();
  store.set("remote", storedTokens({ expiresAt: Date.now() - 1 }));

  const binding = createHttpAuthBinding({
    config: {
      id: "remote",
      transport: { type: "http", url: "https://mcp.example/rpc", auth: baseConfig() },
    },
    store,
    fetch: endpoint.fetch,
  });

  assert.ok(binding);
  assert.equal(binding.client.serverId, "remote");
  assert.equal(await binding.client.getAccessToken(), "access-bound");
});

// ---------------------------------------------------------------------------
// Token stores
// ---------------------------------------------------------------------------

test("coerceTokenSet drops unusable records instead of throwing", () => {
  assert.equal(coerceTokenSet(undefined), undefined);
  assert.equal(coerceTokenSet({ accessToken: "" }), undefined);
  assert.equal(coerceTokenSet([{ accessToken: "x" }]), undefined);

  const coerced = coerceTokenSet({ accessToken: "abc", expiresAt: "not-a-number" });
  assert.equal(coerced?.tokenType, "Bearer");
  assert.equal(coerced?.expiresAt, undefined);
});

test("FileTokenStore round-trips credentials with owner-only permissions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "action-hub-auth-"));
  const path = join(dir, "credentials.json");
  try {
    const store = new FileTokenStore({ path });
    await store.set("srv-a", storedTokens());
    await store.set("srv-b", storedTokens({ accessToken: "access-b" }));

    assert.equal((await store.get("srv-a"))?.accessToken, "access-original");
    assert.equal((await store.get("srv-b"))?.accessToken, "access-b");
    assert.deepEqual(await store.keys(), ["srv-a", "srv-b"]);

    const mode = (await stat(path)).mode & 0o777;
    assert.equal(mode, 0o600, "credentials must not be world- or group-readable");

    await store.delete("srv-a");
    assert.equal(await store.get("srv-a"), undefined);
    assert.equal((await store.get("srv-b"))?.accessToken, "access-b");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent FileTokenStore writes do not lose updates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "action-hub-auth-"));
  const path = join(dir, "credentials.json");
  try {
    const store = new FileTokenStore({ path });
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        store.set(`srv-${i}`, storedTokens({ accessToken: `access-${i}` })),
      ),
    );
    assert.equal((await store.keys()).length, 10, "a read-modify-write race would drop entries");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an unreadable credential file degrades into re-authorization", async () => {
  const dir = await mkdtemp(join(tmpdir(), "action-hub-auth-"));
  const path = join(dir, "credentials.json");
  try {
    await writeFile(path, "{ not json", "utf8");
    const warnings: string[] = [];
    const store = new FileTokenStore({ path, onWarning: (m) => warnings.push(m) });

    assert.equal(await store.get("srv"), undefined);
    assert.equal(warnings.length, 1);

    // A missing file is normal on first run and must not warn.
    const fresh = new FileTokenStore({ path: join(dir, "absent.json"), onWarning: (m) => warnings.push(m) });
    assert.equal(await fresh.get("srv"), undefined);
    assert.equal(warnings.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a store that cannot persist still yields a usable in-memory token", async () => {
  const endpoint = tokenEndpoint([{ body: { access_token: "access-fresh", expires_in: 3600 } }]);
  const warnings: string[] = [];
  const failing = {
    get: () => storedTokens({ expiresAt: Date.now() - 1 }),
    set: () => {
      throw new Error("keychain locked");
    },
    delete: () => {},
  };

  const client = new OAuthClient({
    serverId: "srv",
    config: baseConfig(),
    store: failing,
    fetch: endpoint.fetch,
    onWarning: (m) => warnings.push(m),
  });

  assert.equal(await client.getAccessToken(), "access-fresh");
  assert.ok(warnings.some((m) => m.includes("could not persist")));
});
