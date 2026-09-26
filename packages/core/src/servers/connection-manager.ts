import type {
  CircuitState,
  HeartbeatConfig,
  McpClient,
  McpClientFactory,
  RestartBackoffConfig,
  ServerConfig,
  ServerState,
  ServerStatus,
  TrustTier,
} from "../types.js";
import {
  computeRestartBackoffMs,
  DEFAULT_BACKOFF_INITIAL_MS,
  DEFAULT_BACKOFF_JITTER,
  DEFAULT_BACKOFF_MAX_MS,
} from "./restart-backoff.js";
import {
  errorHasTransportCode,
  isTransportFailure,
  markTransportFailure,
  ToolError,
} from "./transport-errors.js";

export {
  classifyDownstreamError,
  isTransportFailure,
  markTransportFailure,
  ToolError,
} from "./transport-errors.js";

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  cooldownMs?: number;
}

export interface TimerHandle {
  unref?: () => unknown;
}

export interface ConnectionManagerHooks {
  now?: () => number;
  random?: () => number;
  setTimeout?: (handler: () => void, ms: number) => TimerHandle;
  clearTimeout?: (handle: TimerHandle) => void;
}

export interface ConnectionManagerOptions extends CircuitBreakerOptions, ConnectionManagerHooks {
  /** Default threshold for consecutive execute timeouts per server (F26).
   * Per-server config.executeTimeoutThreshold overrides. 0 disables. Default 5. */
  executeTimeoutThreshold?: number;
  heartbeat?: HeartbeatConfig;
  restartBackoff?: RestartBackoffConfig;
  maxOldSpaceSizeMb?: number;
  /** Per-server deadline for activation (spawn + initialize), covering the
   * phase before the index/execute timeout can start. Defaults to 10s.
   * A server's own config.timeoutMs takes precedence. (F27) */
  activationTimeoutMs?: number;
}

export interface HealthCheckResult {
  serverId: string;
  status: ServerStatus;
  latencyMs?: number;
  error?: string;
  circuitState?: CircuitState;
}

interface Entry {
  config: ServerConfig;
  status: ServerStatus;
  client?: McpClient;
  /** In-flight activation, shared so concurrent callers don't double-connect. */
  pending?: Promise<McpClient>;
  /** Abort controller for the in-flight activation (F27): shutdown paths
   * abort it so a never-initializing connect releases its child. */
  activationAbort?: AbortController;
  error?: string;
  toolCount: number;
  lastActivatedAt?: string;
  consecutiveFailures: number;
  /** Consecutive execute-timeout streak (F26): only a successful execute
   * resets it; tool errors and transport failures never do. */
  consecutiveTimeouts: number;
  /** Why the circuit was tripped, when it was NOT plain transport failures
   * (F26): surfaced in doctor/list/states and the activate() error. */
  circuitOpenReason?: string;
  lastFailureTime?: number;
  lastLatencyMs?: number;
  circuitState: CircuitState;
  halfOpen: boolean;
  generation: number;
  restartAttempt: number;
  autoRestart: boolean;
  manualShutdown: boolean;
  restartTimer?: TimerHandle;
  heartbeatTimer?: TimerHandle;
  nextRestartAt?: number;
  lastHeartbeatAt?: number;
}

/**
 * Abort reason used by manual shutdown/replacement paths (deactivate,
 * reconnect, closeAll). Distinguishes a deliberate abort from a deadline
 * expiry so the activation catch never records failures or overwrites
 * disabled/inactive status for a manual shutdown (F27 rework 3).
 */
const SHUTDOWN_ABORT_REASON = new Error("Activation cancelled by shutdown");
function isShutdownAbort(signal: AbortSignal): boolean {
  return signal.reason === SHUTDOWN_ABORT_REASON;
}

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_EXECUTE_TIMEOUT_THRESHOLD = 5;
const DEFAULT_COOLDOWN_MS = 10_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_ACTIVATION_TIMEOUT_MS = 10_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 5_000;

/**
 * Owns the lifecycle of downstream MCP servers.
 *
 * Activation is lazy by design: a configured server is not spawned or
 * authenticated until one of its actions is actually executed. This is what
 * makes a hundred configured integrations free until used.
 */
/**
 * Wraps a client so execute-time callTool rejections are classified at the
 * boundary instead of by message text. Errors carrying a numeric `code` or an
 * McpError-style type are JSON-RPC/tool-layer responses from a live server
 * and are rethrown unmarked; everything else thrown by callTool is tagged as
 * a transport failure (Not connected, EPIPE, closed stdio, ...).
 */
function tagTransportFailures(client: McpClient): McpClient {
  return {
    listTools: (options) => client.listTools(options),
    callTool: async (name, args, options) => {
      try {
        return await client.callTool(name, args, options);
      } catch (cause) {
        if (errorHasTransportCode(cause, 0)) {
          throw markTransportFailure(cause as Error);
        }
        throw cause;
      }
    },
    close: () => client.close(),
  };
}

export class ConnectionManager {
  readonly #entries = new Map<string, Entry>();
  readonly #factory: McpClientFactory;
  readonly #failureThreshold: number;
  readonly #executeTimeoutThreshold: number;
  readonly #cooldownMs: number;
  readonly #heartbeat: HeartbeatConfig;
  readonly #restartBackoff: RestartBackoffConfig;
  readonly #maxOldSpaceSizeMb?: number;
  readonly #activationTimeoutMs: number;
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #setTimeout: (handler: () => void, ms: number) => TimerHandle;
  readonly #clearTimeout: (handle: TimerHandle) => void;
  #closed = false;

  constructor(
    factory: McpClientFactory,
    configs: readonly ServerConfig[] = [],
    options: ConnectionManagerOptions = {},
  ) {
    this.#factory = factory;
    this.#failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.#executeTimeoutThreshold = options.executeTimeoutThreshold ?? DEFAULT_EXECUTE_TIMEOUT_THRESHOLD;
    this.#cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.#heartbeat = options.heartbeat ?? {};
    this.#restartBackoff = options.restartBackoff ?? {};
    this.#maxOldSpaceSizeMb = options.maxOldSpaceSizeMb;
    this.#activationTimeoutMs = options.activationTimeoutMs ?? DEFAULT_ACTIVATION_TIMEOUT_MS;
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
    this.#setTimeout =
      options.setTimeout ??
      ((handler, ms) => {
        const handle = setTimeout(handler, ms);
        handle.unref?.();
        return handle;
      });
    this.#clearTimeout = options.clearTimeout ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
    for (const config of configs) this.register(config);
  }

  register(config: ServerConfig): void {
    if (this.#entries.has(config.id)) {
      throw new Error(`Server "${config.id}" is already registered`);
    }
    this.#entries.set(config.id, this.#newEntry(config));
  }

  getConfig(serverId: string): ServerConfig | undefined {
    return this.#entries.get(serverId)?.config;
  }

  configs(): ServerConfig[] {
    return [...this.#entries.values()].map((entry) => entry.config);
  }

  trustOf(serverId: string): TrustTier {
    const entry = this.#entries.get(serverId);
    if (!entry) return "blocked";
    if (entry.config.enabled === false) return "blocked";
    return entry.config.trust ?? "untrusted";
  }

  isEnabled(serverId: string): boolean {
    const entry = this.#entries.get(serverId);
    return Boolean(entry) && entry?.config.enabled !== false;
  }

  setEnabled(serverId: string, enabled: boolean): void {
    const entry = this.#requireEntry(serverId);
    entry.config = { ...entry.config, enabled };
    if (!enabled) {
      entry.status = "disabled";
      void this.deactivate(serverId);
    } else if (entry.status === "disabled") {
      entry.status = "inactive";
      entry.manualShutdown = true;
      entry.autoRestart = false;
    }
  }

  /**
   * Retiers a server at runtime. Catalog records copy trust at index time, so
   * callers must re-index (or re-tag) after changing it for search and policy
   * to agree with the new tier.
   */
  setTrust(serverId: string, trust: TrustTier): void {
    const entry = this.#requireEntry(serverId);
    entry.config = { ...entry.config, trust };
  }

  recordToolCount(serverId: string, count: number): void {
    const entry = this.#entries.get(serverId);
    if (entry) entry.toolCount = count;
  }

  status(serverId: string): ServerState["status"] | undefined {
    return this.#entries.get(serverId)?.status;
  }

  getStatus(serverId: string): ServerState["status"] | undefined {
    return this.#entries.get(serverId)?.status;
  }

  circuitState(serverId: string): CircuitState | undefined {
    const entry = this.#entries.get(serverId);
    return entry ? this.#circuitState(entry) : undefined;
  }

  isCircuitOpen(serverId: string): boolean {
    const entry = this.#entries.get(serverId);
    if (!entry) return false;
    return this.#circuitState(entry) === "open";
  }

  recordSuccess(serverId: string, latencyMs?: number): void {
    const entry = this.#entries.get(serverId);
    if (!entry || entry.manualShutdown) return;
    entry.consecutiveFailures = 0;
    entry.circuitOpenReason = undefined;
    entry.lastFailureTime = undefined;
    entry.error = undefined;
    entry.circuitState = "closed";
    entry.halfOpen = false;
    entry.restartAttempt = 0;
    entry.nextRestartAt = undefined;
    this.#clearRestartTimer(entry);
    if (latencyMs !== undefined) entry.lastLatencyMs = latencyMs;
    if (entry.status !== "disabled" && entry.client) {
      entry.status = "ready";
    }
  }

  /**
   * A successful EXECUTE (F26): like recordSuccess, but additionally resets
   * the consecutive execute-timeout streak. Deliberately separate: health
   * checks and heartbeats report success from listTools — a server that
   * answers pings while every tools/call hangs would otherwise keep wiping
   * the streak and never be isolated.
   */
  recordExecuteSuccess(serverId: string, latencyMs?: number): void {
    const entry = this.#entries.get(serverId);
    if (!entry || entry.manualShutdown) return;
    entry.consecutiveTimeouts = 0;
    this.recordSuccess(serverId, latencyMs);
  }

  recordFailure(serverId: string, error?: string): void {
    const entry = this.#entries.get(serverId);
    if (!entry || entry.manualShutdown || entry.config.enabled === false) return;
    entry.consecutiveFailures += 1;
    entry.lastFailureTime = this.#now();
    entry.error = error;
    entry.halfOpen = false;
    const threshold = this.#threshold(entry);
    if (entry.consecutiveFailures >= threshold) {
      entry.circuitState = "open";
      entry.status = "unreachable";
    } else if (entry.consecutiveFailures > 1 || entry.client) {
      entry.circuitState = "closed";
      entry.status = "degraded";
    } else {
      entry.circuitState = "closed";
      entry.status = "error";
    }
  }

  /**
   * Reports a failure observed while executing a tool. Only transport-level
   * callTool rejections (tagged by the client wrapper — see
   * isTransportFailure) count against the circuit breaker; tool errors,
   * JSON-RPC error responses, isError results, and tool timeouts never do.
   *
   * Once the breaker opens, the known-bad client reference is released
   * synchronously and closed in the background with a bounded timeout — the
   * failing execute's response never waits on a close that may never settle.
   * A restart is scheduled after the cooldown (same recovery path as a failed
   * health check). The cached client is deliberately kept while the breaker is
   * closed: a stdio connect can succeed even with a dead child, so reconnecting
   * per failure would reset the failure count on each connect and the circuit
   * would never open.
   */
  async reportExecuteFailure(serverId: string, cause: unknown, message?: string): Promise<void> {
    if (!isTransportFailure(cause)) return;
    const entry = this.#entries.get(serverId);
    if (!entry || entry.manualShutdown || entry.config.enabled === false) return;
    this.recordFailure(serverId, message ?? (cause instanceof Error ? cause.message : String(cause)));
    if (this.#circuitState(entry) === "open") {
      this.#stopHeartbeat(entry);
      const client = entry.client;
      entry.client = undefined;
      if (client) {
        // Bounded background close: a dead transport's close may never settle.
        void this.#withTimeout(client.close(), 2_000, "close timed out").catch(() => {});
      }
      this.#scheduleRestart(entry);
    }
  }

  /**
   * Reports an EXECUTE timeout observed while running a tool (F26). Tool
   * timeouts deliberately never counted as transport failures (a slow
   * handler is not a dead transport), but a server that answers heartbeat
   * pings while every tools/call hangs would otherwise never be isolated:
   * every caller waits the full execution timeout forever. A streak of
   * consecutive timeouts trips the circuit with a distinct reason and the
   * same cooldown/half-open recovery as transport failures. Only a
   * successful execute resets the streak; tool errors never count, and
   * transport failures keep their existing path.
   */
  recordExecuteTimeout(serverId: string, message?: string): void {
    const entry = this.#entries.get(serverId);
    if (!entry || entry.manualShutdown || entry.config.enabled === false) return;
    entry.consecutiveTimeouts += 1;
    const threshold = this.#timeoutThreshold(entry);
    if (threshold <= 0) return; // 0 disables the policy
    if (entry.consecutiveTimeouts < threshold) return;
    // Trip: distinct reason, same cooldown/half-open machinery. Advancing
    // consecutiveFailures to the transport threshold drives #circuitState
    // (open -> half-open after cooldown) without double-counting timeouts
    // as transport failures.
    entry.circuitOpenReason = `repeated execute timeouts (${entry.consecutiveTimeouts} in a row)`;
    entry.error = entry.circuitOpenReason;
    entry.consecutiveFailures = this.#threshold(entry);
    entry.lastFailureTime = this.#now();
    entry.halfOpen = false;
    entry.circuitState = "open";
    entry.status = "unreachable";
    // Same recovery as a tripped transport breaker: stop probing a server
    // that hangs, release its client (bounded close), and schedule a
    // restart after the cooldown. No NEW restart behavior: a timeout trip
    // recovers exactly like any other open circuit. (activate() normally
    // sets autoRestart; a timeout can trip before the first activate.)
    entry.autoRestart = true;
    this.#stopHeartbeat(entry);
    const client = entry.client;
    entry.client = undefined;
    if (client) {
      void this.#withTimeout(client.close(), 2_000, "close timed out").catch(() => {});
    }
    this.#scheduleRestart(entry);
  }

  #timeoutThreshold(entry: Entry): number {
    return entry.config.executeTimeoutThreshold ?? this.#executeTimeoutThreshold;
  }

  resetCircuit(serverId: string): void {
    const entry = this.#entries.get(serverId);
    if (!entry) return;
    entry.consecutiveFailures = 0;
    entry.consecutiveTimeouts = 0;
    entry.circuitOpenReason = undefined;
    entry.lastFailureTime = undefined;
    entry.error = undefined;
    entry.circuitState = "closed";
    entry.halfOpen = false;
    entry.restartAttempt = 0;
    entry.nextRestartAt = undefined;
    this.#clearRestartTimer(entry);
    if (entry.status !== "disabled") {
      entry.status = entry.client ? "ready" : "inactive";
    }
  }

  /**
   * Connects on first use and reuses the client thereafter. Concurrent callers
   * share a single in-flight connection attempt.
   */
  async activate(serverId: string): Promise<McpClient> {
    if (this.#closed) {
      throw new Error("Connection manager is closed");
    }
    const entry = this.#requireEntry(serverId);

    if (entry.config.enabled === false) {
      throw new Error(`Server "${serverId}" is disabled`);
    }

    if (entry.client) return entry.client;
    if (entry.pending) return entry.pending;

    const state = this.#circuitState(entry);
    if (state === "open") {
      const reason = entry.circuitOpenReason ? ` — ${entry.circuitOpenReason}` : "";
      throw new Error(
        `Circuit breaker open for server "${serverId}": too many consecutive failures${reason}. Cooling down.`,
      );
    }

    entry.manualShutdown = false;
    entry.autoRestart = true;
    this.#clearRestartTimer(entry);

    if (state === "half-open") {
      entry.halfOpen = true;
      entry.circuitState = "half-open";
    }

    entry.status = entry.status === "unreachable" || state === "half-open" ? "reconnecting" : "connecting";
    entry.error = undefined;

    const generation = ++entry.generation;
    const config = this.#factoryConfig(entry);

    // F27: activation (spawn + initialize) has a deadline — the index/execute
    // timeout only starts after activate() returns, so without this a server
    // that never answers initialize hangs startup forever. The deadline is
    // the server's config.timeoutMs if set, else the activation default.
    const deadlineMs = entry.config.timeoutMs ?? this.#activationTimeoutMs;
    const controller = new AbortController();
    entry.activationAbort = controller;
    let deadlineTimer: TimerHandle | undefined = undefined;
    const clearDeadline = (): void => {
      if (deadlineTimer !== undefined) this.#clearTimeout(deadlineTimer);
      deadlineTimer = undefined;
    };
    const timedOut = new Promise<never>((_, reject) => {
      deadlineTimer = this.#setTimeout(() => {
        controller.abort();
        reject(
          new Error(
            `Activation of server "${serverId}" timed out after ${deadlineMs}ms (spawn + initialize deadline)`,
          ),
        );
      }, deadlineMs);
    });

    let pendingRef: Promise<McpClient> | undefined;
    // Deadline bookkeeping must happen EXACTLY once regardless of which
    // rejection arrives first: a cooperative factory rejects on the abort
    // (inner catch) before the timer race rejects (outer catch).
    let deadlineBookkept = false;
    const bookkeepDeadline = (message: string): void => {
      if (deadlineBookkept) return;
      deadlineBookkept = true;
      entry.generation += 1;
      if (entry.pending === pendingRef) entry.pending = undefined;
      this.recordFailure(serverId, message);
      entry.status = "unreachable";
      // Schedule AFTER the pending handle is cleared: scheduleRestart
      // refuses while a pending activation exists.
      this.#scheduleRestart(entry);
    };
    const pending = (async (): Promise<McpClient> => {
      try {
        const client = await this.#factory(config, { signal: controller.signal });
        clearDeadline();
        if (this.#closed || entry.generation !== generation || entry.manualShutdown || entry.config.enabled === false) {
          try {
            await client.close();
          } catch {
            // Discarded connect after shutdown must not surface.
          }
          throw new Error(`Server "${serverId}" was shut down during connect`);
        }
        entry.activationAbort = undefined;
        entry.client = tagTransportFailures(client);
        entry.status = "ready";
        entry.lastActivatedAt = new Date(this.#now()).toISOString();
        entry.consecutiveFailures = 0;
        entry.lastFailureTime = undefined;
        entry.circuitState = "closed";
        entry.halfOpen = false;
        entry.restartAttempt = 0;
        entry.nextRestartAt = undefined;
        entry.pending = undefined;
        entry.error = undefined;
        this.#startHeartbeat(entry);
        return entry.client;
      } catch (cause) {
        clearDeadline();
        if (entry.pending === pendingRef) entry.pending = undefined;
        // Deadline bookkeeping is centralized (bookkeepDeadline is
        // exactly-once) and takes precedence: a cooperative factory's abort
        // rejection arrives HERE before the timer race rejects. Manual
        // shutdown aborts are skipped entirely (no failure recorded, no
        // status overwrite).
        if (controller.signal.aborted && !isShutdownAbort(controller.signal)) {
          bookkeepDeadline(cause instanceof Error ? cause.message : String(cause));
          throw cause;
        }
        if (entry.generation !== generation) throw cause;
        this.recordFailure(serverId, cause instanceof Error ? cause.message : String(cause));
        this.#scheduleRestart(entry);
        throw cause;
      }
    })();

    pendingRef = pending;
    entry.pending = pending;
    try {
      return await Promise.race([pending, timedOut]);
    } catch (cause) {
      const deadlineExpired = controller.signal.aborted && !isShutdownAbort(controller.signal);
      if (deadlineExpired) {
        // The factory may have rejected on the abort BEFORE this timer race
        // did (inner catch) — bookkeepDeadline is exactly-once either way.
        bookkeepDeadline(cause instanceof Error ? cause.message : String(cause));
      }
      if (controller.signal.aborted) {
        // Deadline or manual shutdown: drop the pending handle so a later
        // activate can retry, and make sure a factory that ignores the
        // AbortSignal cannot turn its late rejection into an unhandled one.
        if (entry.pending === pendingRef) entry.pending = undefined;
        void pendingRef?.catch(() => {});
      }
      throw cause;
    }
  }

  /** Reconnects a server by deactivating and activating again. */
  async reconnect(serverId: string): Promise<McpClient> {
    const entry = this.#requireEntry(serverId);
    if (entry.config.enabled === false) {
      throw new Error(`Server "${serverId}" is disabled`);
    }
    if (this.#closed) {
      throw new Error("Connection manager is closed");
    }
    entry.status = "reconnecting";
    entry.manualShutdown = false;
    entry.autoRestart = true;
    this.#clearRestartTimer(entry);
    this.#stopHeartbeat(entry);
    // Abort the in-flight activation (releases its child) and settle it
    // bounded before starting the replacement — otherwise the old connect
    // keeps initializing until its own deadline with a lost controller.
    entry.activationAbort?.abort(SHUTDOWN_ABORT_REASON);
    entry.activationAbort = undefined;
    await this.#settlePendingBounded(entry);
    entry.generation += 1;
    entry.pending = undefined;
    await this.#dropClient(entry);
    this.resetCircuit(serverId);
    return this.activate(serverId);
  }

  /** Probes server health by checking latency and ability to list tools. */
  async checkHealth(serverId: string): Promise<HealthCheckResult> {
    const entry = this.#requireEntry(serverId);
    if (entry.config.enabled === false) {
      return { serverId, status: "disabled", circuitState: this.#circuitState(entry) };
    }

    const start = this.#now();
    let client: McpClient;
    try {
      client = await this.activate(serverId);
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      return { serverId, status: entry.status, error, circuitState: this.#circuitState(entry) };
    }

    try {
      await this.#probe(entry, client);
      const latencyMs = Math.max(0, this.#now() - start);
      this.recordSuccess(serverId, latencyMs);
      entry.lastHeartbeatAt = this.#now();
      return { serverId, status: "ready", latencyMs, circuitState: this.#circuitState(entry) };
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      this.recordFailure(serverId, error);
      if (this.#circuitState(entry) === "open") {
        this.#stopHeartbeat(entry);
        await this.#dropClient(entry);
        this.#scheduleRestart(entry);
      }
      return { serverId, status: entry.status, error, circuitState: this.#circuitState(entry) };
    }
  }

  async checkAllHealth(): Promise<HealthCheckResult[]> {
    const ids = [...this.#entries.keys()];
    return Promise.all(ids.map((id) => this.checkHealth(id)));
  }

  async deactivate(serverId: string): Promise<void> {
    const entry = this.#entries.get(serverId);
    if (!entry) return;
    entry.manualShutdown = true;
    entry.autoRestart = false;
    this.#clearRestartTimer(entry);
    this.#stopHeartbeat(entry);
    // Abort an in-flight activation so its spawned child is released, then
    // wait bounded for the connect to settle — shutdown must not leave a
    // hung child behind and must not wait on a wedged connect either.
    entry.activationAbort?.abort(SHUTDOWN_ABORT_REASON);
    entry.activationAbort = undefined;
    await this.#settlePendingBounded(entry);
    entry.generation += 1;
    entry.pending = undefined;
    await this.#dropClient(entry);
    if (entry.status !== "disabled") entry.status = "inactive";
    entry.nextRestartAt = undefined;
  }

  /** Waits at most ~2.5s (real time — teardown is not simulated) for an
   * in-flight activation to settle after its abort. */
  async #settlePendingBounded(entry: Entry): Promise<void> {
    const pending = entry.pending;
    if (!pending) return;
    await Promise.race([
      pending.catch(() => {}),
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 2_500);
        t.unref?.();
      }),
    ]);
  }

  async closeAll(): Promise<void> {
    this.#closed = true;
    await Promise.all([...this.#entries.keys()].map((id) => this.deactivate(id)));
  }

  states(): ServerState[] {
    return [...this.#entries.values()].map((entry) => {
      const circuitState = this.#circuitState(entry);
      return {
        id: entry.config.id,
        displayName: entry.config.displayName ?? entry.config.id,
        status: entry.status,
        trust: entry.config.trust ?? "untrusted",
        toolCount: entry.toolCount,
        error: entry.error,
        lastActivatedAt: entry.lastActivatedAt,
        latencyMs: entry.lastLatencyMs,
        circuitOpen: circuitState === "open",
        circuitState,
        consecutiveFailures: entry.consecutiveFailures,
        executeTimeoutStreak: entry.consecutiveTimeouts,
        restartAttempt: entry.restartAttempt,
        nextRestartAt: entry.nextRestartAt !== undefined ? new Date(entry.nextRestartAt).toISOString() : undefined,
        lastHeartbeatAt:
          entry.lastHeartbeatAt !== undefined ? new Date(entry.lastHeartbeatAt).toISOString() : undefined,
        memoryLimitMb: entry.config.maxOldSpaceSizeMb ?? this.#maxOldSpaceSizeMb,
      };
    });
  }

  #newEntry(config: ServerConfig): Entry {
    return {
      config,
      status: config.enabled === false ? "disabled" : "inactive",
      toolCount: 0,
      consecutiveFailures: 0,
      consecutiveTimeouts: 0,
      circuitState: "closed",
      halfOpen: false,
      generation: 0,
      restartAttempt: 0,
      autoRestart: false,
      manualShutdown: config.enabled === false,
    };
  }

  #requireEntry(serverId: string): Entry {
    const entry = this.#entries.get(serverId);
    if (!entry) throw new Error(`Unknown server "${serverId}"`);
    return entry;
  }

  #threshold(entry: Entry): number {
    return entry.config.circuitBreaker?.failureThreshold ?? this.#failureThreshold;
  }

  #cooldown(entry: Entry): number {
    return entry.config.circuitBreaker?.cooldownMs ?? this.#cooldownMs;
  }

  #circuitState(entry: Entry): CircuitState {
    if (entry.halfOpen) return "half-open";
    if (entry.consecutiveFailures < this.#threshold(entry)) return "closed";
    const lastFailure = entry.lastFailureTime;
    if (lastFailure === undefined) return "open";
    if (this.#now() - lastFailure < this.#cooldown(entry)) return "open";
    return "half-open";
  }

  #factoryConfig(entry: Entry): ServerConfig {
    const mb = entry.config.maxOldSpaceSizeMb ?? this.#maxOldSpaceSizeMb;
    if (mb === undefined || mb === entry.config.maxOldSpaceSizeMb) return entry.config;
    return { ...entry.config, maxOldSpaceSizeMb: mb };
  }

  #backoff(entry: Entry): RestartBackoffConfig {
    return {
      initialMs: entry.config.restartBackoff?.initialMs ?? this.#restartBackoff.initialMs ?? DEFAULT_BACKOFF_INITIAL_MS,
      maxMs: entry.config.restartBackoff?.maxMs ?? this.#restartBackoff.maxMs ?? DEFAULT_BACKOFF_MAX_MS,
      jitter: entry.config.restartBackoff?.jitter ?? this.#restartBackoff.jitter ?? DEFAULT_BACKOFF_JITTER,
    };
  }

  #heartbeatOptions(entry: Entry): { enabled: boolean; intervalMs: number; timeoutMs: number } {
    const cfg = entry.config.heartbeat;
    return {
      enabled: cfg?.enabled ?? this.#heartbeat.enabled ?? true,
      intervalMs: cfg?.intervalMs ?? this.#heartbeat.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
      timeoutMs: cfg?.timeoutMs ?? this.#heartbeat.timeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS,
    };
  }

  async #probe(entry: Entry, client: McpClient): Promise<void> {
    const timeoutMs = this.#heartbeatOptions(entry).timeoutMs;
    await this.#withTimeout(client.listTools(), timeoutMs, "Health check timed out");
  }

  async #withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let handle: TimerHandle | undefined;
    const timeout = new Promise<never>((_, reject) => {
      handle = this.#setTimeout(() => reject(new Error(message)), timeoutMs);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (handle) this.#clearTimeout(handle);
    }
  }

  #startHeartbeat(entry: Entry): void {
    this.#stopHeartbeat(entry);
    const options = this.#heartbeatOptions(entry);
    if (!options.enabled) return;

    const tick = (): void => {
      entry.heartbeatTimer = this.#setTimeout(() => {
        void this.#heartbeatOnce(entry).finally(() => {
          if (entry.client && !entry.manualShutdown && !this.#closed) tick();
        });
      }, options.intervalMs);
    };
    tick();
  }

  #stopHeartbeat(entry: Entry): void {
    if (entry.heartbeatTimer) {
      this.#clearTimeout(entry.heartbeatTimer);
      entry.heartbeatTimer = undefined;
    }
  }

  async #heartbeatOnce(entry: Entry): Promise<void> {
    if (!entry.client || entry.manualShutdown || this.#closed || entry.config.enabled === false) return;
    try {
      const start = this.#now();
      await this.#probe(entry, entry.client);
      const latencyMs = Math.max(0, this.#now() - start);
      this.recordSuccess(entry.config.id, latencyMs);
      entry.lastHeartbeatAt = this.#now();
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      this.recordFailure(entry.config.id, error);
      if (this.#circuitState(entry) === "open") {
        this.#stopHeartbeat(entry);
        await this.#dropClient(entry);
        this.#scheduleRestart(entry);
      }
    }
  }

  #scheduleRestart(entry: Entry): void {
    if (this.#closed || entry.manualShutdown || !entry.autoRestart || entry.config.enabled === false) return;
    if (entry.restartTimer || entry.pending || entry.client) return;

    const backoff = this.#backoff(entry);
    const delay = computeRestartBackoffMs({
      attempt: entry.restartAttempt,
      initialMs: backoff.initialMs,
      maxMs: backoff.maxMs,
      jitter: backoff.jitter,
      random: this.#random,
    });
    entry.restartAttempt += 1;

    const remainingCooldown =
      this.#circuitState(entry) === "open"
        ? Math.max(0, this.#cooldown(entry) - (this.#now() - (entry.lastFailureTime ?? this.#now())))
        : 0;
    const wait = Math.max(delay, remainingCooldown);
    entry.nextRestartAt = this.#now() + wait;

    entry.restartTimer = this.#setTimeout(() => {
      entry.restartTimer = undefined;
      entry.nextRestartAt = undefined;
      if (this.#closed || entry.manualShutdown || !entry.autoRestart || entry.config.enabled === false) return;
      if (entry.client || entry.pending) return;
      void this.activate(entry.config.id).catch(() => {
        // Failure already recorded; another restart is scheduled from activate.
      });
    }, wait);
  }

  #clearRestartTimer(entry: Entry): void {
    if (entry.restartTimer) {
      this.#clearTimeout(entry.restartTimer);
      entry.restartTimer = undefined;
    }
    entry.nextRestartAt = undefined;
  }

  async #dropClient(entry: Entry): Promise<void> {
    this.#stopHeartbeat(entry);
    const client = entry.client;
    entry.client = undefined;
    if (!client) return;
    try {
      await client.close();
    } catch {
      // A downstream server that fails to close cleanly must not prevent the
      // hub from releasing its reference.
    }
  }
}
