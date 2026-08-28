import type {
  McpClient,
  McpClientFactory,
  ServerConfig,
  ServerState,
  ServerStatus,
  TrustTier,
} from "../types.js";

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  cooldownMs?: number;
}

export interface HealthCheckResult {
  serverId: string;
  status: ServerStatus;
  latencyMs?: number;
  error?: string;
}

interface Entry {
  config: ServerConfig;
  status: ServerStatus;
  client?: McpClient;
  /** In-flight activation, shared so concurrent callers don't double-connect. */
  pending?: Promise<McpClient>;
  error?: string;
  toolCount: number;
  lastActivatedAt?: string;
  consecutiveFailures: number;
  lastFailureTime?: number;
  lastLatencyMs?: number;
}

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 10_000;
const HEALTH_CHECK_TIMEOUT_MS = 5_000;

/**
 * Owns the lifecycle of downstream MCP servers.
 *
 * Activation is lazy by design: a configured server is not spawned or
 * authenticated until one of its actions is actually executed. This is what
 * makes a hundred configured integrations free until used.
 */
export class ConnectionManager {
  readonly #entries = new Map<string, Entry>();
  readonly #factory: McpClientFactory;
  readonly #failureThreshold: number;
  readonly #cooldownMs: number;

  constructor(
    factory: McpClientFactory,
    configs: readonly ServerConfig[] = [],
    circuitOptions: CircuitBreakerOptions = {},
  ) {
    this.#factory = factory;
    this.#failureThreshold = circuitOptions.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.#cooldownMs = circuitOptions.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    for (const config of configs) this.register(config);
  }

  register(config: ServerConfig): void {
    if (this.#entries.has(config.id)) {
      throw new Error(`Server "${config.id}" is already registered`);
    }
    this.#entries.set(config.id, {
      config,
      status: config.enabled === false ? "disabled" : "inactive",
      toolCount: 0,
      consecutiveFailures: 0,
    });
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

  isCircuitOpen(serverId: string): boolean {
    const entry = this.#entries.get(serverId);
    if (!entry) return false;
    if (entry.consecutiveFailures < this.#failureThreshold) return false;
    if (!entry.lastFailureTime) return false;
    // Check if cooldown has elapsed
    const elapsed = Date.now() - entry.lastFailureTime;
    return elapsed < this.#cooldownMs;
  }

  recordSuccess(serverId: string, latencyMs?: number): void {
    const entry = this.#entries.get(serverId);
    if (!entry) return;
    entry.consecutiveFailures = 0;
    entry.lastFailureTime = undefined;
    entry.error = undefined;
    if (latencyMs !== undefined) entry.lastLatencyMs = latencyMs;
    if (entry.status !== "disabled" && entry.client) {
      entry.status = "ready";
    }
  }

  recordFailure(serverId: string, error?: string): void {
    const entry = this.#entries.get(serverId);
    if (!entry) return;
    entry.consecutiveFailures += 1;
    entry.lastFailureTime = Date.now();
    entry.error = error;
    if (entry.consecutiveFailures >= this.#failureThreshold) {
      entry.status = "unreachable";
    } else if (entry.consecutiveFailures > 1) {
      entry.status = "degraded";
    } else {
      entry.status = "error";
    }
  }

  resetCircuit(serverId: string): void {
    const entry = this.#entries.get(serverId);
    if (!entry) return;
    entry.consecutiveFailures = 0;
    entry.lastFailureTime = undefined;
    entry.error = undefined;
    if (entry.status !== "disabled") {
      entry.status = entry.client ? "ready" : "inactive";
    }
  }

  /**
   * Connects on first use and reuses the client thereafter. Concurrent callers
   * share a single in-flight connection attempt.
   */
  async activate(serverId: string): Promise<McpClient> {
    const entry = this.#requireEntry(serverId);

    if (entry.config.enabled === false) {
      throw new Error(`Server "${serverId}" is disabled`);
    }

    if (this.isCircuitOpen(serverId)) {
      throw new Error(
        `Circuit breaker open for server "${serverId}": too many consecutive failures. Cooling down.`,
      );
    }

    if (entry.client) return entry.client;
    if (entry.pending) return entry.pending;

    entry.status = entry.status === "unreachable" ? "reconnecting" : "connecting";
    entry.error = undefined;

    const pending = this.#factory(entry.config)
      .then((client) => {
        entry.client = client;
        entry.status = "ready";
        entry.lastActivatedAt = new Date().toISOString();
        entry.consecutiveFailures = 0;
        entry.lastFailureTime = undefined;
        entry.pending = undefined;
        return client;
      })
      .catch((cause: unknown) => {
        this.recordFailure(serverId, cause instanceof Error ? cause.message : String(cause));
        entry.pending = undefined;
        throw cause;
      });

    entry.pending = pending;
    return pending;
  }

  /** Reconnects a server by deactivating and activating again. */
  async reconnect(serverId: string): Promise<McpClient> {
    const entry = this.#requireEntry(serverId);
    entry.status = "reconnecting";
    await this.deactivate(serverId);
    this.resetCircuit(serverId);
    return this.activate(serverId);
  }

  /** Probes server health by checking latency and ability to list tools. */
  async checkHealth(serverId: string): Promise<HealthCheckResult> {
    const entry = this.#requireEntry(serverId);
    if (entry.config.enabled === false) {
      return { serverId, status: "disabled" };
    }

    const start = Date.now();
    try {
      const client = await this.activate(serverId);
      let timer: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Health check timed out")), HEALTH_CHECK_TIMEOUT_MS);
      });

      try {
        await Promise.race([client.listTools(), timeoutPromise]);
      } finally {
        if (timer) clearTimeout(timer);
      }

      const latencyMs = Date.now() - start;
      this.recordSuccess(serverId, latencyMs);
      return { serverId, status: "ready", latencyMs };
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      this.recordFailure(serverId, error);
      return { serverId, status: entry.status, error };
    }
  }

  async checkAllHealth(): Promise<HealthCheckResult[]> {
    const ids = [...this.#entries.keys()];
    return Promise.all(ids.map((id) => this.checkHealth(id)));
  }

  async deactivate(serverId: string): Promise<void> {
    const entry = this.#entries.get(serverId);
    if (!entry?.client) return;
    const client = entry.client;
    entry.client = undefined;
    if (entry.status === "ready" || entry.status === "connecting" || entry.status === "reconnecting") {
      entry.status = "inactive";
    }
    try {
      await client.close();
    } catch {
      // A downstream server that fails to close cleanly must not prevent the
      // hub from releasing its reference.
    }
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.#entries.keys()].map((id) => this.deactivate(id)));
  }

  states(): ServerState[] {
    return [...this.#entries.values()].map((entry) => ({
      id: entry.config.id,
      displayName: entry.config.displayName ?? entry.config.id,
      status: entry.status,
      trust: entry.config.trust ?? "untrusted",
      toolCount: entry.toolCount,
      error: entry.error,
      lastActivatedAt: entry.lastActivatedAt,
      latencyMs: entry.lastLatencyMs,
      circuitOpen: this.isCircuitOpen(entry.config.id),
    }));
  }

  #requireEntry(serverId: string): Entry {
    const entry = this.#entries.get(serverId);
    if (!entry) throw new Error(`Unknown server "${serverId}"`);
    return entry;
  }
}
