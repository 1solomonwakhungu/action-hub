import { OAuthError, redactSecrets } from "./errors.js";
import { createPkcePair, createStateValue } from "./pkce.js";
import { InMemoryTokenStore } from "./token-store.js";
import type {
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
import { summarizeTokens } from "./errors.js";

const DEFAULT_REFRESH_LEEWAY_SECONDS = 60;

export interface OAuthClientOptions {
  /** Server this credential belongs to. Used as the store key and in errors. */
  serverId: string;
  config: OAuthClientConfig;
  /** Defaults to an in-memory store, i.e. credentials last one process. */
  store?: TokenStore;
  /** Injectable for tests and for hosts with a proxy-aware fetch. */
  fetch?: FetchLike;
  /** Injectable clock, in epoch milliseconds. */
  now?: () => number;
  /** Receives secret-free lifecycle notes. Never called with a token value. */
  onWarning?: (message: string) => void;
}

/**
 * OAuth 2.0 client for a single downstream server.
 *
 * Responsibilities, in the order they matter:
 *
 *  1. **Hand out a valid access token.** `getAccessToken` is the only method
 *     the transport layer needs. It refreshes ahead of expiry rather than
 *     waiting for a 401, because a 401 costs a wasted round trip and, on some
 *     providers, a rate-limit penalty.
 *  2. **Refresh exactly once under concurrency.** A hub activating several
 *     tools at once produces a burst of simultaneous requests against one
 *     expired token. Every one of them joins a single in-flight refresh; a
 *     provider that rotates refresh tokens would otherwise see N concurrent
 *     uses of a one-time token and revoke the whole grant.
 *  3. **Handle rotation.** RFC 6749 §6 lets a provider return a new refresh
 *     token, and OAuth 2.1 makes rotation the norm. The new value replaces the
 *     old one atomically in the store; when none is returned, the existing one
 *     is carried forward.
 *  4. **Fail explicitly.** A revoked grant (`invalid_grant`) is not a transient
 *     error — the stored credential is dropped and an `authorization_required`
 *     error is raised so the host can prompt, instead of retrying forever.
 *
 * No token value ever reaches a log, an error message, or a persisted catalog.
 */
export class OAuthClient {
  readonly serverId: string;
  readonly #config: OAuthClientConfig;
  readonly #store: TokenStore;
  readonly #fetch: FetchLike;
  readonly #now: () => number;
  readonly #warn: (message: string) => void;

  #cached: TokenSet | undefined;
  #loadedFromStore = false;
  #state: AuthState = "unauthenticated";
  /** Shared in-flight renewal; the mechanism behind refresh deduplication. */
  #inFlight: Promise<TokenSet> | undefined;

  constructor(options: OAuthClientOptions) {
    this.serverId = options.serverId;
    this.#config = options.config;
    this.#store = options.store ?? new InMemoryTokenStore();
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#now = options.now ?? (() => Date.now());
    this.#warn = options.onWarning ?? (() => {});

    assertUsableConfig(this.#config, this.serverId);
  }

  get grantType(): OAuthGrantType {
    return this.#config.grantType ?? "authorization_code";
  }

  /** Header name the token should be sent under. */
  get headerName(): string {
    return this.#config.headerName ?? "Authorization";
  }

  /** Last observed authentication state. Cheap; never performs I/O. */
  state(): AuthState {
    return this.#state;
  }

  /**
   * Returns a token that is valid now, refreshing or minting one if needed.
   *
   * Throws {@link OAuthError} with code `authorization_required` when the only
   * way forward is a human completing {@link createAuthorizationRequest}.
   */
  async getAccessToken(options: { forceRefresh?: boolean } = {}): Promise<string> {
    const current = await this.#currentTokens();

    if (!options.forceRefresh && current && !this.#isExpired(current)) {
      this.#state = "authenticated";
      return current.accessToken;
    }

    const renewed = await this.#renew(current);
    return renewed.accessToken;
  }

  /**
   * Returns everything needed to authorize one request: the header to set, its
   * formatted value, and the bare token.
   *
   * The bare token is included so a caller that later sees a 401 can pass it
   * back to {@link invalidateAccessToken} and prove *which* token failed.
   * An empty `headerScheme` sends the bare token, which a handful of providers
   * require.
   */
  async getAuthorization(
    options: { forceRefresh?: boolean } = {},
  ): Promise<{ headerName: string; headerValue: string; accessToken: string }> {
    const accessToken = await this.getAccessToken(options);
    const scheme = this.#config.headerScheme ?? "Bearer";
    return {
      headerName: this.headerName,
      headerValue: scheme.length > 0 ? `${scheme} ${accessToken}` : accessToken,
      accessToken,
    };
  }

  /**
   * Marks the stored access token unusable so the next call refreshes.
   *
   * `staleToken` guards against a lost update: when several requests are in
   * flight and one of them 401s on an *already-replaced* token, invalidating
   * unconditionally would throw away the good token that a concurrent refresh
   * just produced. Passing the token that actually failed makes the
   * invalidation a no-op in that case.
   */
  async invalidateAccessToken(staleToken?: string): Promise<void> {
    const current = await this.#currentTokens();
    if (!current) return;
    if (staleToken !== undefined && current.accessToken !== staleToken) return;

    const invalidated: TokenSet = { ...current, expiresAt: 0 };
    await this.#persist(invalidated);
    this.#state = "expired";
  }

  /** Stores a credential obtained out of band (e.g. by a host login flow). */
  async setTokens(tokens: TokenSet): Promise<void> {
    await this.#persist(tokens);
    this.#state = this.#isExpired(tokens) ? "expired" : "authenticated";
  }

  /** Drops the stored credential entirely. The next call requires authorization. */
  async clear(): Promise<void> {
    this.#cached = undefined;
    this.#loadedFromStore = true;
    this.#state = "unauthenticated";
    await this.#store.delete(this.serverId);
  }

  /** Secret-free description of the stored credential, for `status` output. */
  async describe(): Promise<{ state: AuthState; tokens?: TokenSummary }> {
    const current = await this.#currentTokens();
    if (current) this.#state = this.#isExpired(current) ? "expired" : "authenticated";
    return { state: this.#state, tokens: summarizeTokens(current) };
  }

  /**
   * Builds the URL a user must visit, plus the one-time values the callback
   * has to be checked against.
   *
   * The caller owns `state` and `codeVerifier` until the redirect comes back —
   * keeping them out of this object's fields means two concurrent logins
   * cannot clobber each other.
   */
  createAuthorizationRequest(
    overrides: { redirectUri?: string; scopes?: string[] } = {},
  ): AuthorizationRequest {
    const authorizationUrl = this.#config.authorizationUrl;
    if (!authorizationUrl) {
      throw new OAuthError(
        "invalid_configuration",
        this.serverId,
        "authorizationUrl is required to start an authorization-code flow",
        { retryable: false },
      );
    }

    const redirectUri = overrides.redirectUri ?? this.#config.redirectUri;
    if (!redirectUri) {
      throw new OAuthError(
        "invalid_configuration",
        this.serverId,
        "redirectUri is required to start an authorization-code flow",
        { retryable: false },
      );
    }

    const state = createStateValue();
    const url = new URL(authorizationUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.#config.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);

    const scopes = overrides.scopes ?? this.#config.scopes;
    if (scopes && scopes.length > 0) url.searchParams.set("scope", scopes.join(" "));
    if (this.#config.audience) url.searchParams.set("audience", this.#config.audience);
    if (this.#config.resource) url.searchParams.set("resource", this.#config.resource);
    for (const [key, value] of Object.entries(this.#config.extraAuthorizationParams ?? {})) {
      url.searchParams.set(key, value);
    }

    let codeVerifier: string | undefined;
    if (this.#usePkce()) {
      const pkce = createPkcePair();
      codeVerifier = pkce.codeVerifier;
      url.searchParams.set("code_challenge", pkce.codeChallenge);
      url.searchParams.set("code_challenge_method", pkce.codeChallengeMethod);
    }

    return { url: url.toString(), state, codeVerifier, redirectUri };
  }

  /** Exchanges a callback code for a credential and stores it. */
  async exchangeAuthorizationCode(params: {
    code: string;
    codeVerifier?: string;
    redirectUri: string;
    /** Value received on the callback; compared against `expectedState`. */
    returnedState?: string;
    expectedState?: string;
  }): Promise<TokenSummary> {
    if (
      params.expectedState !== undefined &&
      params.returnedState !== undefined &&
      params.expectedState !== params.returnedState
    ) {
      this.#state = "error";
      throw new OAuthError(
        "state_mismatch",
        this.serverId,
        "authorization callback returned a mismatched state parameter",
        { retryable: false },
      );
    }

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: params.redirectUri,
    });
    if (params.codeVerifier) body.set("code_verifier", params.codeVerifier);

    const tokens = await this.#requestToken(body, "token_request_failed");
    await this.#persist(tokens);
    this.#state = "authenticated";
    return summarizeTokens(tokens) as TokenSummary;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  #usePkce(): boolean {
    return this.#config.usePkce ?? true;
  }

  #leewayMs(): number {
    const seconds = this.#config.refreshLeewaySeconds ?? DEFAULT_REFRESH_LEEWAY_SECONDS;
    return Math.max(0, seconds) * 1000;
  }

  #isExpired(tokens: TokenSet): boolean {
    if (tokens.expiresAt === undefined) return false;
    return tokens.expiresAt - this.#leewayMs() <= this.#now();
  }

  /** Reads through to the store once, then serves the in-memory copy. */
  async #currentTokens(): Promise<TokenSet | undefined> {
    if (!this.#loadedFromStore) {
      this.#cached = await this.#readStore();
      this.#loadedFromStore = true;
      if (this.#cached) {
        this.#state = this.#isExpired(this.#cached) ? "expired" : "authenticated";
      }
    }
    return this.#cached;
  }

  async #readStore(): Promise<TokenSet | undefined> {
    try {
      return (await this.#store.get(this.serverId)) ?? undefined;
    } catch (cause) {
      this.#warn(`could not read stored credentials: ${message(cause)}`);
      return undefined;
    }
  }

  async #persist(tokens: TokenSet): Promise<void> {
    this.#cached = tokens;
    this.#loadedFromStore = true;
    try {
      await this.#store.set(this.serverId, tokens);
    } catch (cause) {
      // A store that cannot persist still leaves a usable in-memory token; the
      // cost is re-authorizing after a restart, not a failed request now.
      this.#warn(`could not persist credentials: ${message(cause)}`);
    }
  }

  /**
   * Single-flight renewal.
   *
   * The promise is published *before* it is awaited, so every caller that
   * arrives while it is pending joins it instead of starting a second token
   * request. The slot is cleared as the promise settles — including on
   * rejection — so a later call is free to try again.
   */
  #renew(current: TokenSet | undefined): Promise<TokenSet> {
    const existing = this.#inFlight;
    if (existing) return existing;

    this.#state = "refreshing";
    const run = this.#renewNow(current).finally(() => {
      this.#inFlight = undefined;
    });
    this.#inFlight = run;
    return run;
  }

  async #renewNow(current: TokenSet | undefined): Promise<TokenSet> {
    // Another process sharing this store may have rotated the credential while
    // this one held a stale copy. Re-reading first turns that into a cache hit
    // rather than a redundant — and, under rotation, destructive — refresh.
    const latest = (await this.#readStore()) ?? current;
    if (latest && !this.#isExpired(latest) && latest !== current) {
      this.#cached = latest;
      this.#state = "authenticated";
      return latest;
    }

    if (latest?.refreshToken) {
      return this.#refresh(latest);
    }

    if (this.grantType === "client_credentials") {
      return this.#clientCredentials();
    }

    this.#state = "unauthenticated";
    throw new OAuthError(
      "authorization_required",
      this.serverId,
      latest
        ? "the stored access token expired and no refresh token is available; re-authorize this server"
        : "no stored credentials; authorize this server before use",
      { retryable: false },
    );
  }

  async #refresh(current: TokenSet): Promise<TokenSet> {
    const refreshToken = current.refreshToken;
    if (!refreshToken) {
      throw new OAuthError("authorization_required", this.serverId, "no refresh token available", {
        retryable: false,
      });
    }

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    const scopes = this.#config.scopes;
    if (scopes && scopes.length > 0) body.set("scope", scopes.join(" "));

    let tokens: TokenSet;
    try {
      tokens = await this.#requestToken(body, "refresh_failed", current);
    } catch (cause) {
      // `invalid_grant` on a refresh means the grant is gone — revoked, or a
      // rotated token replayed. Retrying cannot fix it, and keeping the dead
      // credential would make every later call fail the same way, so it is
      // dropped and the host is told to re-authorize.
      if (cause instanceof OAuthError && cause.oauthError === "invalid_grant") {
        await this.clear();
        throw new OAuthError(
          "authorization_required",
          this.serverId,
          "the refresh token was rejected (invalid_grant); re-authorize this server",
          { status: cause.status, oauthError: cause.oauthError, retryable: false },
        );
      }
      this.#state = "error";
      throw cause;
    }

    await this.#persist(tokens);
    this.#state = "authenticated";
    return tokens;
  }

  async #clientCredentials(): Promise<TokenSet> {
    const body = new URLSearchParams({ grant_type: "client_credentials" });
    const scopes = this.#config.scopes;
    if (scopes && scopes.length > 0) body.set("scope", scopes.join(" "));

    let tokens: TokenSet;
    try {
      tokens = await this.#requestToken(body, "token_request_failed");
    } catch (cause) {
      this.#state = "error";
      throw cause;
    }
    await this.#persist(tokens);
    this.#state = "authenticated";
    return tokens;
  }

  /**
   * Posts to the token endpoint and normalises the result.
   *
   * `carryForward` supplies the refresh token to keep when the provider does
   * not rotate one — dropping it there would silently downgrade a renewable
   * credential into a single-use one.
   */
  async #requestToken(
    body: URLSearchParams,
    failureCode: "refresh_failed" | "token_request_failed",
    carryForward?: TokenSet,
  ): Promise<TokenSet> {
    for (const [key, value] of Object.entries(this.#config.extraTokenParams ?? {})) {
      body.set(key, value);
    }
    if (this.#config.resource) body.set("resource", this.#config.resource);
    if (this.#config.audience) body.set("audience", this.#config.audience);

    const headers: Record<string, string> = {
      "content-type": "application/x-www-form-urlencoded",
      // GitHub in particular returns form-encoded unless JSON is requested.
      accept: "application/json",
    };

    const method = this.#clientAuthMethod();
    if (method === "client_secret_basic") {
      const credentials = `${encodeURIComponent(this.#config.clientId)}:${encodeURIComponent(
        this.#config.clientSecret ?? "",
      )}`;
      headers["authorization"] = `Basic ${Buffer.from(credentials, "utf8").toString("base64")}`;
    } else {
      body.set("client_id", this.#config.clientId);
      if (method === "client_secret_post" && this.#config.clientSecret) {
        body.set("client_secret", this.#config.clientSecret);
      }
    }

    let response: Response;
    try {
      response = await this.#fetch(this.#config.tokenUrl, {
        method: "POST",
        headers,
        body: body.toString(),
      });
    } catch (cause) {
      throw new OAuthError(
        "network_error",
        this.serverId,
        `token endpoint unreachable: ${this.#scrub(message(cause))}`,
        { cause, retryable: true },
      );
    }

    const payload = await this.#readJson(response);

    if (!response.ok) {
      // Only the two RFC 6749 error fields are echoed. A token endpoint is the
      // one place a raw body could carry a credential, so it is never surfaced.
      const oauthError = readString(payload, "error");
      const description = readString(payload, "error_description");
      const detail = [oauthError, description].filter((part) => part !== undefined).join(": ");
      throw new OAuthError(
        failureCode,
        this.serverId,
        `token request failed with HTTP ${response.status}${detail ? ` (${this.#scrub(detail)})` : ""}`,
        {
          status: response.status,
          oauthError,
          retryable: failureCode === "refresh_failed" && response.status >= 500,
        },
      );
    }

    const accessToken = readString(payload, "access_token");
    if (!accessToken) {
      throw new OAuthError(
        failureCode,
        this.serverId,
        "token response did not contain an access_token",
        { status: response.status, retryable: false },
      );
    }

    const now = this.#now();
    const expiresIn = readNumber(payload, "expires_in");
    const rotated = readString(payload, "refresh_token");

    return {
      accessToken,
      tokenType: readString(payload, "token_type") ?? "Bearer",
      expiresAt: expiresIn === undefined ? undefined : now + expiresIn * 1000,
      // Rotation: a returned refresh token always replaces the old one. When
      // the provider returns none, the previous token stays valid per RFC 6749.
      refreshToken: rotated ?? carryForward?.refreshToken,
      scope: readString(payload, "scope") ?? carryForward?.scope,
      obtainedAt: now,
    };
  }

  #clientAuthMethod(): ClientAuthMethod {
    if (this.#config.clientAuthMethod) return this.#config.clientAuthMethod;
    return this.#config.clientSecret ? "client_secret_basic" : "none";
  }

  async #readJson(response: Response): Promise<Record<string, unknown>> {
    let text: string;
    try {
      text = await response.text();
    } catch {
      return {};
    }
    try {
      const parsed: unknown = JSON.parse(text);
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  /** Second line of defence: strip configured secrets out of any rendered text. */
  #scrub(text: string): string {
    return redactSecrets(text, [this.#config.clientSecret, this.#cached?.refreshToken]);
  }
}

function assertUsableConfig(config: OAuthClientConfig, serverId: string): void {
  if (!config.tokenUrl || config.tokenUrl.length === 0) {
    throw new OAuthError("invalid_configuration", serverId, "oauth config requires a tokenUrl", {
      retryable: false,
    });
  }
  if (!config.clientId || config.clientId.length === 0) {
    throw new OAuthError("invalid_configuration", serverId, "oauth config requires a clientId", {
      retryable: false,
    });
  }
  if ((config.grantType ?? "authorization_code") === "client_credentials" && !config.clientSecret) {
    // Public clients cannot use client credentials: the grant authenticates the
    // client itself, so a missing secret would fail at the provider instead.
    throw new OAuthError(
      "invalid_configuration",
      serverId,
      "the client_credentials grant requires a clientSecret",
      { retryable: false },
    );
  }
}

function readString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  // Several providers send `expires_in` as a string despite the RFC.
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
