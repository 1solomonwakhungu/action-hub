import type {
  McpClient,
  McpClientFactory,
  ServerConfig,
  ServerState,
  ServerStatus,
  TrustTier,
} from "../types.js";

interface Entry {
  config: ServerConfig;
  status: ServerStatus;
  client?: McpClient;
  /** In-flight activation, shared so concurrent callers don't double-connect. */
  pending?: Promise<McpClient>;
  error?: string;
  toolCount: number;
  lastActivatedAt?: string;
}

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

  constructor(factory: McpClientFactory, configs: readonly ServerConfig[] = []) {
    this.#factory = factory;
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

  recordToolCount(serverId: string, count: number): void {
    const entry = this.#entries.get(serverId);
    if (entry) entry.toolCount = count;
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
    if (entry.client) return entry.client;
    if (entry.pending) return entry.pending;

    entry.status = "connecting";
    entry.error = undefined;

    const pending = this.#factory(entry.config)
      .then((client) => {
        entry.client = client;
        entry.status = "ready";
        entry.lastActivatedAt = new Date().toISOString();
        entry.pending = undefined;
        return client;
      })
      .catch((cause: unknown) => {
        entry.status = "error";
        entry.error = cause instanceof Error ? cause.message : String(cause);
        entry.pending = undefined;
        throw cause;
      });

    entry.pending = pending;
    return pending;
  }

  async deactivate(serverId: string): Promise<void> {
    const entry = this.#entries.get(serverId);
    if (!entry?.client) return;
    const client = entry.client;
    entry.client = undefined;
    if (entry.status === "ready") entry.status = "inactive";
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
    }));
  }

  #requireEntry(serverId: string): Entry {
    const entry = this.#entries.get(serverId);
    if (!entry) throw new Error(`Unknown server "${serverId}"`);
    return entry;
  }
}
