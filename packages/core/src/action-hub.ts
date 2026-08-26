import { Catalog } from "./catalog/catalog.js";
import { CATALOG_CACHE_VERSION, type PersistedCatalog } from "./catalog/persistence.js";
import { SearchEngine, type SemanticScorer } from "./search/search.js";
import { ConnectionManager } from "./servers/connection-manager.js";
import { PermissionPolicy, isToolPermitted, type PolicyOptions } from "./permissions/policy.js";
import { ApprovalRegistry, type ApprovalRegistryOptions } from "./permissions/approvals.js";
import { validateArguments } from "./router/validate.js";
import type {
  ActionRecord,
  ExecuteResult,
  InvocationRecord,
  LoadedAction,
  McpClientFactory,
  SearchHit,
  SearchOptions,
  ServerConfig,
  ServerState,
} from "./types.js";

export interface ActionHubOptions {
  servers?: readonly ServerConfig[];
  clientFactory: McpClientFactory;
  policy?: PolicyOptions;
  semanticScorer?: SemanticScorer;
  /** Ring-buffer size for invocation history. */
  historyLimit?: number;
  /**
   * When true, an action whose policy decision requires approval is refused
   * outright rather than offered an approval token. For hosts that cannot
   * prompt a user at all and must fail closed.
   */
  denyOnApprovalRequired?: boolean;
  /** Token lifetime and clock for the approval gate. */
  approvals?: ApprovalRegistryOptions;
}

export interface ExecuteOptions {
  /** Token returned by a previous gated execute of this exact call. */
  approvalToken?: string;
}

export interface IndexResult {
  serverId: string;
  indexed: number;
  error?: string;
}

export interface HubSnapshot {
  indexedAt: string;
  servers: Record<string, ServerState>;
  skills: number;
  context: { actions: number; eagerTokensEstimate: number; hubTokensEstimate: number };
  history: InvocationRecord[];
}

const DEFAULT_HISTORY_LIMIT = 200;

/**
 * The façade the host integration talks to.
 *
 * Exposes exactly three operations — search, load, execute — mirroring the
 * single tool surface presented to the model.
 */
export class ActionHub {
  readonly #catalog = new Catalog();
  readonly #search: SearchEngine;
  readonly #connections: ConnectionManager;
  readonly #policy: PermissionPolicy;
  readonly #history: InvocationRecord[] = [];
  readonly #historyLimit: number;
  readonly #denyOnApprovalRequired: boolean;
  readonly #approvals: ApprovalRegistry;

  constructor(options: ActionHubOptions) {
    this.#connections = new ConnectionManager(options.clientFactory, options.servers ?? []);
    this.#search = new SearchEngine(this.#catalog);
    this.#search.setSemanticScorer(options.semanticScorer);
    this.#policy = new PermissionPolicy(options.policy ?? {});
    this.#historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT;
    this.#denyOnApprovalRequired = options.denyOnApprovalRequired ?? false;
    this.#approvals = new ApprovalRegistry(options.approvals ?? {});
  }

  get catalog(): Catalog {
    return this.#catalog;
  }

  get connections(): ConnectionManager {
    return this.#connections;
  }

  /**
   * Connects to each enabled server once, reads its tool list, and indexes it.
   *
   * Indexing is the one place a server must be contacted eagerly. Failures are
   * captured per-server so one broken integration cannot prevent the rest of
   * the catalog from being built.
   */
  async indexAll(): Promise<IndexResult[]> {
    const configs = this.#connections.configs().filter((config) => config.enabled !== false);
    return Promise.all(configs.map((config) => this.indexServer(config.id)));
  }

  async indexServer(serverId: string): Promise<IndexResult> {
    const config = this.#connections.getConfig(serverId);
    if (!config) return { serverId, indexed: 0, error: `Unknown server "${serverId}"` };

    try {
      const client = await this.#connections.activate(serverId);
      const tools = await client.listTools();
      const trust = this.#connections.trustOf(serverId);

      const records: ActionRecord[] = tools
        .filter((tool) => isToolPermitted(config, tool.name))
        .map((tool) => ({
          id: Catalog.actionId(serverId, tool.name),
          kind: "tool" as const,
          serverId,
          name: tool.name,
          summary: summarize(tool.description ?? tool.name),
          description: tool.description,
          inputSchema: tool.inputSchema ?? {},
          trust,
        }));

      this.#catalog.removeServer(serverId);
      this.#catalog.addAll(records);
      this.#connections.recordToolCount(serverId, records.length);
      return { serverId, indexed: records.length };
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      return { serverId, indexed: 0, error };
    }
  }

  /**
   * Registers skills into the same catalog as tools.
   *
   * Only the summary is indexed — skill bodies are deliberately never injected
   * into context, which is the whole reason skills are indexed rather than
   * loaded up front.
   */
  registerSkills(records: readonly Omit<ActionRecord, "kind">[]): void {
    this.#catalog.addAll(records.map((record) => ({ ...record, kind: "skill" as const })));
  }

  /** Cheap, schema-free retrieval. */
  async search(query: string, options?: SearchOptions): Promise<SearchHit[]> {
    return this.#search.search(query, options);
  }

  /** The only path that returns a full JSON Schema. */
  load(actionId: string): LoadedAction {
    const record = this.#catalog.get(actionId);
    if (!record) throw new ActionHubError(`Unknown action "${actionId}"`, "unknown_action");
    return {
      id: record.id,
      kind: record.kind,
      serverId: record.serverId,
      name: record.name,
      summary: record.summary,
      description: record.description,
      inputSchema: record.inputSchema ?? {},
      trust: record.trust,
    };
  }

  /**
   * Runs an action, subject to policy.
   *
   * When the policy gates the action, this does *not* run it. It returns an
   * `ApprovalRequest` carrying a single-use token; passing that token back on
   * an identical call is what actually executes it.
   */
  async execute(
    actionId: string,
    args: Record<string, unknown> = {},
    options: ExecuteOptions = {},
  ): Promise<ExecuteResult> {
    const startedAt = new Date().toISOString();
    const start = Date.now();

    const record = this.#catalog.get(actionId);
    if (!record) {
      return this.#fail(actionId, "unknown", `Unknown action "${actionId}"`, startedAt, start);
    }

    // Checked before policy: a skill has no downstream server to evaluate
    // against, and it can never be dispatched regardless of trust.
    if (record.kind === "skill") {
      return this.#fail(
        actionId,
        record.serverId,
        `"${actionId}" is a skill and must be loaded, not executed`,
        startedAt,
        start,
      );
    }

    // Deny is evaluated first and is unconditional. An approval token is only
    // ever offered for a call the policy already permits, so approval can never
    // become a path around a disabled server, a blocked tier, or a deny-list.
    const decision = this.#policy.evaluate(record, this.#connections.getConfig(record.serverId));
    if (!decision.allowed) {
      return this.#fail(actionId, record.serverId, decision.reason ?? "Denied by policy", startedAt, start);
    }

    // Validated before the gate so a user is never asked to approve a call that
    // would fail locally anyway, and so a bad call cannot burn a valid token.
    const validation = validateArguments(record.inputSchema, args);
    if (!validation.valid) {
      return this.#fail(
        actionId,
        record.serverId,
        `Invalid arguments: ${validation.errors.join("; ")}`,
        startedAt,
        start,
      );
    }

    let approved = false;
    if (decision.requiresApproval) {
      const reason = decision.reason ?? `Server "${record.serverId}" is ${record.trust}`;

      if (options.approvalToken) {
        const check = this.#approvals.consume(options.approvalToken, actionId, args);
        if (!check.ok) {
          return this.#fail(
            actionId,
            record.serverId,
            `Approval rejected: ${check.reason ?? "invalid approval token"}`,
            startedAt,
            start,
            "required",
          );
        }
        approved = true;
      } else if (this.#denyOnApprovalRequired) {
        return this.#fail(
          actionId,
          record.serverId,
          `Approval required: ${reason}`,
          startedAt,
          start,
          "required",
        );
      } else {
        const approval = this.#approvals.issue({
          actionId,
          serverId: record.serverId,
          name: record.name,
          trust: record.trust,
          reason,
          args,
        });
        const durationMs = Date.now() - start;
        this.#record({
          actionId,
          serverId: record.serverId,
          startedAt,
          durationMs,
          ok: false,
          error: `Approval required: ${reason}`,
          approval: "required",
        });
        return {
          ok: false,
          actionId,
          error: `Approval required: ${reason}`,
          durationMs,
          approval,
        };
      }
    }

    try {
      const client = await this.#connections.activate(record.serverId);
      const content = await client.callTool(record.name, args);
      const durationMs = Date.now() - start;
      this.#record({
        actionId,
        serverId: record.serverId,
        startedAt,
        durationMs,
        ok: true,
        ...(approved ? { approval: "approved" as const } : {}),
      });
      return { ok: true, actionId, content, durationMs };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return this.#fail(
        actionId,
        record.serverId,
        message,
        startedAt,
        start,
        approved ? "approved" : undefined,
      );
    }
  }

  /** Outstanding, unexpired approval tokens. Diagnostics only. */
  pendingApprovals(): number {
    return this.#approvals.size;
  }

  serverStates(): ServerState[] {
    return this.#connections.states();
  }

  history(): readonly InvocationRecord[] {
    return this.#history;
  }

  /**
   * Approximate context saved versus injecting every schema on every turn.
   * Uses a 4-characters-per-token heuristic, which is close enough for the
   * diagnostics surface and avoids a tokenizer dependency in the core.
   */
  contextStats(): { actions: number; eagerTokensEstimate: number; hubTokensEstimate: number } {
    const actions = this.#catalog.all();
    const eagerChars = actions.reduce((sum, record) => {
      const schema = record.inputSchema ? JSON.stringify(record.inputSchema).length : 0;
      return sum + record.name.length + (record.description?.length ?? 0) + schema;
    }, 0);
    return {
      actions: actions.length,
      eagerTokensEstimate: Math.ceil(eagerChars / 4),
      hubTokensEstimate: HUB_TOOL_TOKENS,
    };
  }

  /**
   * A serializable view of everything a diagnostics surface needs. The core
   * builds it but never persists it — where a snapshot goes is a host concern.
   */
  snapshot(): HubSnapshot {
    return {
      indexedAt: new Date().toISOString(),
      servers: Object.fromEntries(this.#connections.states().map((state) => [state.id, state])),
      skills: this.#catalog.filter({ kind: "skill" }).length,
      context: this.contextStats(),
      history: [...this.#history],
    };
  }

  /**
   * Rehydrates the catalog from a persisted entry, skipping the eager
   * round-trip to every downstream server.
   *
   * Only the catalog is restored. Connection state deliberately is not:
   * nothing has been spawned yet, so every server stays `inactive` until an
   * action from it is executed. Actions belonging to servers that are no
   * longer configured are dropped, since they could never be dispatched.
   */
  restoreCatalog(entry: PersistedCatalog): number {
    const known = new Set(this.#connections.configs().map((config) => config.id));
    const records = entry.actions.filter(
      (record) => record.kind === "skill" || known.has(record.serverId),
    );

    for (const serverId of this.#catalog.serverIds()) this.#catalog.removeServer(serverId);
    this.#catalog.addAll(records);

    for (const serverId of known) {
      this.#connections.recordToolCount(serverId, this.#catalog.listByServer(serverId).length);
    }
    return records.length;
  }

  /**
   * The full serializable catalog, ready to be written to a cache.
   *
   * A superset of `snapshot()` — the diagnostics fields are identical, so a
   * single file can serve both the cache and the capability manager canvas.
   */
  toPersisted(configHash: string): PersistedCatalog {
    return {
      version: CATALOG_CACHE_VERSION,
      configHash,
      ...this.snapshot(),
      actions: this.#catalog.all(),
    };
  }

  async close(): Promise<void> {
    await this.#connections.closeAll();
  }

  #fail(
    actionId: string,
    serverId: string,
    error: string,
    startedAt: string,
    start: number,
    approval?: InvocationRecord["approval"],
  ): ExecuteResult {
    const durationMs = Date.now() - start;
    this.#record({
      actionId,
      serverId,
      startedAt,
      durationMs,
      ok: false,
      error,
      ...(approval ? { approval } : {}),
    });
    return { ok: false, actionId, error, durationMs };
  }

  #record(entry: InvocationRecord): void {
    this.#history.push(entry);
    if (this.#history.length > this.#historyLimit) {
      this.#history.splice(0, this.#history.length - this.#historyLimit);
    }
  }
}

/** Rough token cost of the single `action_hub` schema the model always sees. */
const HUB_TOOL_TOKENS = 600;

export class ActionHubError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "ActionHubError";
    this.code = code;
  }
}

const SUMMARY_MAX = 160;

/** Search results carry a single line; full text is reserved for `load`. */
function summarize(text: string): string {
  const firstLine = text.split("\n").find((line) => line.trim().length > 0)?.trim() ?? text.trim();
  if (firstLine.length <= SUMMARY_MAX) return firstLine;
  return `${firstLine.slice(0, SUMMARY_MAX - 1).trimEnd()}…`;
}
