import { Catalog } from "./catalog/catalog.js";
import { CATALOG_CACHE_VERSION, type PersistedCatalog } from "./catalog/persistence.js";
import { BundleRegistry, type Bundle } from "./bundles/bundles.js";
import { SearchEngine, type SemanticScorer } from "./search/search.js";
import { LocalSemanticIndex, type LocalSemanticOptions } from "./search/semantic.js";
import { ConnectionManager, type ConnectionManagerOptions } from "./servers/connection-manager.js";
import { PermissionPolicy, isToolPermitted, type PolicyOptions } from "./permissions/policy.js";
import { ApprovalRegistry, fingerprintArguments, type ApprovalRegistryOptions } from "./permissions/approvals.js";
import { validateArguments } from "./router/validate.js";
import {
  ActionHubTelemetry,
  ACTION_HUB_ATTRIBUTES,
  SpanStatusCode,
  safeByteLength,
  trace,
  context,
  propagation,
  type ActionHubTelemetryOptions,
  type Tracer,
} from "./telemetry/index.js";
import type {
  ActionRecord,
  ExecuteResult,
  HealthCheckResult,
  InvocationRecord,
  LoadedAction,
  LoadedBundle,
  McpClientFactory,
  SearchHit,
  SearchOptions,
  ServerConfig,
  ServerState,
  ResultCacheOptions,
} from "./types.js";

export interface ActionHubOptions {
  servers?: readonly ServerConfig[];
  bundles?: readonly Bundle[];
  clientFactory: McpClientFactory;
  policy?: PolicyOptions;
  /**
   * Optional OpenTelemetry configuration for Action Hub spans.
   * When omitted, uses the OpenTelemetry API's default/global tracer,
   * which safely no-ops unless an SDK/exporter is configured by the host.
   */
  telemetry?: ActionHubTelemetryOptions;
  /**
   * Shorthand to pass a custom Tracer directly.
   */
  tracer?: Tracer;
  /**
   * Default timeout in milliseconds for downstream tool execution.
   * Defaults to 30,000ms (30s) if not specified.
   */
  defaultTimeoutMs?: number;
  /**
   * Overrides the built-in local scorer. Pass `null` to run pure BM25.
   * An external scorer is never awaited on the critical path without a guard —
   * if it throws, search silently degrades to lexical-only.
   */
  semanticScorer?: SemanticScorer | null;
  /**
   * Tuning for the built-in dependency-free semantic index. Ignored when
   * `semanticScorer` is supplied.
   */
  semantic?: LocalSemanticOptions;
  /** Blend weight for the semantic signal. Defaults to 0.2. */
  semanticWeight?: number;
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
  /** Circuit breaker, heartbeat, restart backoff, and memory-limit defaults. */
  resilience?: ConnectionManagerOptions;
  /** Idempotent-read result cache configuration. */
  resultCache?: ResultCacheOptions;
}

export interface ExecuteOptions {
  /** Token returned by a previous gated execute of this exact call. */
  approvalToken?: string;
  /** Bypass the idempotent-read result cache for this call. */
  noCache?: boolean;
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
const DEFAULT_EXECUTION_TIMEOUT_MS = 30_000;

/**
 * The façade the host integration talks to.
 *
 * Exposes exactly three operations — search, load, execute — mirroring the
 * single tool surface presented to the model.
 */
export class ActionHub {
  readonly #catalog = new Catalog();
  readonly #bundles: BundleRegistry;
  readonly #search: SearchEngine;
  readonly #connections: ConnectionManager;
  readonly #policy: PermissionPolicy;
  readonly #history: InvocationRecord[] = [];
  readonly #historyLimit: number;
  readonly #denyOnApprovalRequired: boolean;
  readonly #defaultTimeoutMs: number;
  /** Undefined when the caller supplied their own scorer or disabled scoring. */
  readonly #semanticIndex?: LocalSemanticIndex;
  readonly #approvals: ApprovalRegistry;
  readonly #telemetry: ActionHubTelemetry;
  readonly #resultCache = new Map<string, { content: unknown; expiresAt: number }>();
  readonly #cacheEnabled: boolean;
  readonly #cacheTtlMs: number;
  readonly #cacheMaxEntries: number;

  /** Tool-name prefixes conventionally denoting side-effect-free reads. */
  static readonly #READ_PREFIXES = [
    "get_",
    "list_",
    "read_",
    "describe_",
    "fetch_",
    "search_",
    "find_",
    "query_",
    "inspect_",
    "check_",
  ];

  constructor(options: ActionHubOptions) {
    this.#connections = new ConnectionManager(
      options.clientFactory,
      options.servers ?? [],
      options.resilience ?? {},
    );
    this.#bundles = new BundleRegistry(options.bundles ?? []);
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS;
    this.#telemetry = new ActionHubTelemetry(options.telemetry, options.tracer);
    this.#search = new SearchEngine(this.#catalog);
    if (options.semanticWeight !== undefined) {
      this.#search.setSemanticWeight(options.semanticWeight);
    }
    if (options.semanticScorer === null) {
      this.#search.setSemanticScorer(undefined);
    } else if (options.semanticScorer) {
      this.#search.setSemanticScorer(options.semanticScorer);
    } else {
      // Default: the built-in local index. It adds no dependency and no
      // install-time download, so semantic scoring can be on out of the box.
      this.#semanticIndex = new LocalSemanticIndex(options.semantic);
      this.#search.setSemanticScorer(this.#semanticIndex.asScorer());
    }
    this.#policy = new PermissionPolicy(options.policy ?? {});
    this.#historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT;
    this.#denyOnApprovalRequired = options.denyOnApprovalRequired ?? false;
    this.#approvals = new ApprovalRegistry(options.approvals ?? {});
    this.#cacheEnabled = options.resultCache?.enabled ?? true;
    this.#cacheTtlMs = options.resultCache?.ttlMs ?? 60_000;
    this.#cacheMaxEntries = options.resultCache?.maxEntries ?? 500;
  }

  get catalog(): Catalog {
    return this.#catalog;
  }

  get bundles(): BundleRegistry {
    return this.#bundles;
  }

  get connections(): ConnectionManager {
    return this.#connections;
  }

  get telemetry(): ActionHubTelemetry {
    return this.#telemetry;
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
    const results = await Promise.all(configs.map((config) => this.#indexServer(config.id)));
    this.rebuildSemanticIndex();
    return results;
  }

  async indexServer(serverId: string): Promise<IndexResult> {
    const result = await this.#indexServer(serverId);
    this.rebuildSemanticIndex();
    return result;
  }

  /**
   * Recomputes every action embedding.
   *
   * Embeddings are built here — at index time — and never per query, so query
   * latency stays proportional to the query rather than to the catalog. Call
   * this after mutating `catalog` directly.
   */
  rebuildSemanticIndex(): void {
    this.#semanticIndex?.index(this.#catalog.all());
  }

  async #indexServer(serverId: string): Promise<IndexResult> {
    const config = this.#connections.getConfig(serverId);
    if (!config) return { serverId, indexed: 0, error: `Unknown server "${serverId}"` };

    try {
      const timeoutMs = config.timeoutMs ?? this.#defaultTimeoutMs;
      const client = await this.#connections.activate(serverId);
      const tools = await callWithTimeout(
        client.listTools(),
        timeoutMs,
        `Listing tools for server "${serverId}" timed out after ${timeoutMs}ms`,
      );
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
          readOnly: tool.annotations?.readOnlyHint === true ? true : undefined,
        }));

      // A server listing two tools with the same name yields one id. The first
      // occurrence wins; later duplicates are skipped with a stderr warning so
      // a hostile shadow copy cannot silently replace a real tool.
      const seenIds = new Set<string>();
      const duplicates = new Set<string>();
      const unique: ActionRecord[] = [];
      for (const record of records) {
        if (seenIds.has(record.id)) {
          duplicates.add(record.name);
          continue;
        }
        seenIds.add(record.id);
        unique.push(record);
      }
      if (duplicates.size > 0) {
        process.stderr.write(
          `action-hub: server "${serverId}" listed duplicate tool names; keeping first occurrence of: ${[...duplicates].sort().join(", ")}\n`,
        );
      }

      this.#catalog.removeServer(serverId);
      this.#catalog.addAll(unique);
      this.#connections.recordToolCount(serverId, unique.length);
      return { serverId, indexed: unique.length };
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
    this.rebuildSemanticIndex();
  }

  /**
   * Replaces the entire skill set: existing skill records are dropped first
   * (including ones restored from a warm catalog cache), then the given
   * records are registered. This keeps skills always-live with the current
   * config + skills directory, including removals.
   */
  replaceSkills(records: readonly Omit<ActionRecord, "kind">[]): void {
    this.#catalog.removeKind("skill");
    this.registerSkills(records);
  }

  /** Cheap, schema-free retrieval. */
  async search(query: string, options?: SearchOptions): Promise<SearchHit[]> {
    return this.#telemetry.withActiveSpan(
      "action_hub.search",
      {
        attributes: {
          [ACTION_HUB_ATTRIBUTES.OPERATION]: "search",
          [ACTION_HUB_ATTRIBUTES.SEARCH_QUERY_LENGTH]: query.length,
          [ACTION_HUB_ATTRIBUTES.SEARCH_LIMIT]: options?.limit ?? 10,
          [ACTION_HUB_ATTRIBUTES.SEARCH_INCLUDE_SCHEMA]: options?.includeSchema ?? false,
          ...(options?.serverIds
            ? { [ACTION_HUB_ATTRIBUTES.SEARCH_SERVER_FILTER]: options.serverIds }
            : {}),
          ...(options?.minTrust
            ? { [ACTION_HUB_ATTRIBUTES.SEARCH_MIN_TRUST]: options.minTrust }
            : {}),
        },
      },
      async (span) => {
        const hits = await this.#search.search(query, options);
        span.setAttribute(ACTION_HUB_ATTRIBUTES.SEARCH_RESULT_COUNT, hits.length);
        span.setAttribute(ACTION_HUB_ATTRIBUTES.STATUS, "ok");
        span.setStatus({ code: SpanStatusCode.OK });
        return hits;
      },
    );
  }

  /** The only path that returns a full JSON Schema. */
  load(actionId: string): LoadedAction {
    return this.#telemetry.withSyncSpan(
      "action_hub.load",
      {
        attributes: {
          [ACTION_HUB_ATTRIBUTES.OPERATION]: "load",
          [ACTION_HUB_ATTRIBUTES.ACTION_ID]: actionId,
        },
      },
      (span) => {
        const record = this.#catalog.get(actionId);
        if (!record) {
          span.setAttribute(ACTION_HUB_ATTRIBUTES.STATUS, "error");
          span.setAttribute(ACTION_HUB_ATTRIBUTES.ERROR_CODE, "unknown_action");
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: `Unknown action "${actionId}"`,
          });
          throw new ActionHubError(`Unknown action "${actionId}"`, "unknown_action");
        }
        span.setAttribute(ACTION_HUB_ATTRIBUTES.SERVER_ID, record.serverId);
        span.setAttribute(ACTION_HUB_ATTRIBUTES.ACTION_NAME, record.name);
        span.setAttribute(ACTION_HUB_ATTRIBUTES.ACTION_KIND, record.kind);
        span.setAttribute(ACTION_HUB_ATTRIBUTES.TRUST, record.trust);
        span.setAttribute(ACTION_HUB_ATTRIBUTES.STATUS, "ok");
        span.setStatus({ code: SpanStatusCode.OK });
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
      },
    );
  }

  /** Loads all action schemas in a bundle and computes token metrics. */
  loadBundle(bundleId: string): LoadedBundle {
    return this.#telemetry.withSyncSpan(
      "action_hub.load_bundle",
      {
        attributes: {
          [ACTION_HUB_ATTRIBUTES.OPERATION]: "load_bundle",
          [ACTION_HUB_ATTRIBUTES.BUNDLE_ID]: bundleId,
        },
      },
      (span) => {
        const bundle = this.#bundles.get(bundleId);
        if (!bundle) {
          span.setAttribute(ACTION_HUB_ATTRIBUTES.STATUS, "error");
          span.setAttribute(ACTION_HUB_ATTRIBUTES.ERROR_CODE, "unknown_bundle");
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: `Unknown bundle "${bundleId}"`,
          });
          throw new ActionHubError(`Unknown bundle "${bundleId}"`, "unknown_bundle");
        }

        const records = this.#bundles.resolveActions(bundleId, this.#catalog);
        const actions: LoadedAction[] = records.map((record) => ({
          id: record.id,
          kind: record.kind,
          serverId: record.serverId,
          name: record.name,
          summary: record.summary,
          description: record.description,
          inputSchema: record.inputSchema ?? {},
          trust: record.trust,
        }));

        const eagerChars = actions.reduce((sum, act) => {
          const schema = act.inputSchema ? JSON.stringify(act.inputSchema).length : 0;
          return sum + act.name.length + (act.description?.length ?? 0) + schema;
        }, 0);

        const totalEagerTokens = Math.ceil(eagerChars / 4);
        const totalLazyTokens = HUB_TOOL_TOKENS;
        const tokensSaved = Math.max(0, totalEagerTokens - totalLazyTokens);

        span.setAttribute(ACTION_HUB_ATTRIBUTES.BUNDLE_ACTIONS_COUNT, actions.length);
        span.setAttribute(ACTION_HUB_ATTRIBUTES.BUNDLE_TOTAL_EAGER_TOKENS, totalEagerTokens);
        span.setAttribute(ACTION_HUB_ATTRIBUTES.BUNDLE_TOTAL_LAZY_TOKENS, totalLazyTokens);
        span.setAttribute(ACTION_HUB_ATTRIBUTES.TOKENS_SAVED, tokensSaved);
        span.setAttribute(ACTION_HUB_ATTRIBUTES.STATUS, "ok");
        span.setStatus({ code: SpanStatusCode.OK });

        return {
          id: bundle.id,
          displayName: bundle.displayName,
          description: bundle.description,
          actions,
          totalEagerTokens,
          totalLazyTokens,
          tokensSaved,
        };
      },
    );
  }

  /** Searches available capability bundles. */
  searchBundles(query: string): Bundle[] {
    return this.#bundles.search(query);
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
    const argCount = Object.keys(args).length;
    const reqPayloadSize = safeByteLength(args);

    return this.#telemetry.withActiveSpan(
      "action_hub.execute",
      {
        attributes: {
          [ACTION_HUB_ATTRIBUTES.OPERATION]: "execute",
          [ACTION_HUB_ATTRIBUTES.ACTION_ID]: actionId,
          [ACTION_HUB_ATTRIBUTES.REQUEST_ARGUMENT_COUNT]: argCount,
          [ACTION_HUB_ATTRIBUTES.REQUEST_PAYLOAD_SIZE_BYTES]: reqPayloadSize,
          [ACTION_HUB_ATTRIBUTES.APPROVAL_HAS_TOKEN]: Boolean(options.approvalToken),
        },
      },
      async (span) => {
        const record = this.#catalog.get(actionId);
        if (!record) {
          span.setAttribute(ACTION_HUB_ATTRIBUTES.EXECUTION_STATUS, "failed");
          span.setAttribute(ACTION_HUB_ATTRIBUTES.STATUS, "error");
          span.setAttribute(ACTION_HUB_ATTRIBUTES.ERROR_CODE, "unknown_action");
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: `Unknown action "${actionId}"`,
          });
          return this.#fail(actionId, "unknown", `Unknown action "${actionId}"`, startedAt, start);
        }

        span.setAttribute(ACTION_HUB_ATTRIBUTES.SERVER_ID, record.serverId);
        span.setAttribute(ACTION_HUB_ATTRIBUTES.ACTION_NAME, record.name);
        span.setAttribute(ACTION_HUB_ATTRIBUTES.ACTION_KIND, record.kind);
        span.setAttribute(ACTION_HUB_ATTRIBUTES.TRUST, record.trust);

        // Checked before policy: a skill has no downstream server to evaluate
        // against, and it can never be dispatched regardless of trust.
        if (record.kind === "skill") {
          span.setAttribute(ACTION_HUB_ATTRIBUTES.EXECUTION_STATUS, "failed");
          span.setAttribute(ACTION_HUB_ATTRIBUTES.STATUS, "error");
          span.setAttribute(ACTION_HUB_ATTRIBUTES.ERROR_CODE, "skill_not_executable");
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: `"${actionId}" is a skill and must be loaded, not executed`,
          });
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
          const reason = decision.reason ?? "Denied by policy";
          span.setAttribute(ACTION_HUB_ATTRIBUTES.EXECUTION_STATUS, "rejected");
          span.setAttribute(ACTION_HUB_ATTRIBUTES.STATUS, "rejected");
          span.setAttribute(ACTION_HUB_ATTRIBUTES.ERROR_CODE, "policy_denied");
          span.setAttribute(ACTION_HUB_ATTRIBUTES.ERROR_REASON, reason);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: reason,
          });
          return this.#fail(actionId, record.serverId, reason, startedAt, start);
        }

        // Validated before the gate so a user is never asked to approve a call that
        // would fail locally anyway, and so a bad call cannot burn a valid token.
        const validation = validateArguments(record.inputSchema, args);
        if (!validation.valid) {
          const errorMsg = `Invalid arguments: ${validation.errors.join("; ")}`;
          span.setAttribute(ACTION_HUB_ATTRIBUTES.EXECUTION_STATUS, "failed");
          span.setAttribute(ACTION_HUB_ATTRIBUTES.STATUS, "error");
          span.setAttribute(ACTION_HUB_ATTRIBUTES.ERROR_CODE, "validation_failed");
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: errorMsg,
          });
          return this.#fail(
            actionId,
            record.serverId,
            errorMsg,
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
              const rejMsg = `Approval rejected: ${check.reason ?? "invalid approval token"}`;
              span.setAttribute(ACTION_HUB_ATTRIBUTES.EXECUTION_STATUS, "rejected");
              span.setAttribute(ACTION_HUB_ATTRIBUTES.STATUS, "rejected");
              span.setAttribute(ACTION_HUB_ATTRIBUTES.APPROVAL_STATUS, "rejected");
              span.setAttribute(ACTION_HUB_ATTRIBUTES.APPROVAL_REQUIRED, true);
              span.setAttribute(ACTION_HUB_ATTRIBUTES.ERROR_CODE, "approval_rejected");
              span.setAttribute(
                ACTION_HUB_ATTRIBUTES.ERROR_REASON,
                check.reason ?? "invalid approval token",
              );
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message: rejMsg,
              });
              return this.#fail(
                actionId,
                record.serverId,
                rejMsg,
                startedAt,
                start,
                "required",
              );
            }
            approved = true;
            span.setAttribute(ACTION_HUB_ATTRIBUTES.APPROVAL_STATUS, "approved");
            span.setAttribute(ACTION_HUB_ATTRIBUTES.APPROVAL_REQUIRED, true);
          } else if (this.#denyOnApprovalRequired) {
            const reqMsg = `Approval required: ${reason}`;
            span.setAttribute(ACTION_HUB_ATTRIBUTES.EXECUTION_STATUS, "approval_required");
            span.setAttribute(ACTION_HUB_ATTRIBUTES.STATUS, "approval_required");
            span.setAttribute(ACTION_HUB_ATTRIBUTES.APPROVAL_STATUS, "required");
            span.setAttribute(ACTION_HUB_ATTRIBUTES.APPROVAL_REQUIRED, true);
            span.setAttribute(ACTION_HUB_ATTRIBUTES.ERROR_CODE, "approval_required");
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: reqMsg,
            });
            return this.#fail(
              actionId,
              record.serverId,
              reqMsg,
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
            span.setAttribute(ACTION_HUB_ATTRIBUTES.EXECUTION_STATUS, "approval_required");
            span.setAttribute(ACTION_HUB_ATTRIBUTES.STATUS, "approval_required");
            span.setAttribute(ACTION_HUB_ATTRIBUTES.APPROVAL_STATUS, "required");
            span.setAttribute(ACTION_HUB_ATTRIBUTES.APPROVAL_REQUIRED, true);
            span.setAttribute(ACTION_HUB_ATTRIBUTES.ERROR_CODE, "approval_required");
            span.setAttribute(ACTION_HUB_ATTRIBUTES.EXECUTION_DURATION_MS, durationMs);
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: `Approval required: ${reason}`,
            });
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

        const cacheable =
          this.#cacheEnabled &&
          !options.noCache &&
          !options.approvalToken &&
          !decision.requiresApproval &&
          (record.readOnly === true || ActionHub.#READ_PREFIXES.some((p) => record.name.startsWith(p)));
        if (cacheable) {
          const cacheKey = `${actionId}:${fingerprintArguments(args)}`;
          const cached = this.#resultCache.get(cacheKey);
          if (cached && Date.now() < cached.expiresAt) {
            span.setAttribute(ACTION_HUB_ATTRIBUTES.EXECUTION_STATUS, "success");
            span.setAttribute(ACTION_HUB_ATTRIBUTES.STATUS, "ok");
            span.setAttribute(ACTION_HUB_ATTRIBUTES.EXECUTION_DURATION_MS, 0);
            span.setAttribute("action_hub.cached", true);
            span.setStatus({ code: SpanStatusCode.OK });
            this.#record({
              actionId,
              serverId: record.serverId,
              startedAt,
              durationMs: 0,
              ok: true,
              cached: true,
            });
            return {
              ok: true,
              actionId,
              content: cached.content,
              durationMs: 0,
              cached: true,
            };
          }
        }

        try {
          const serverConfig = this.#connections.getConfig(record.serverId);
          const timeoutMs = serverConfig?.timeoutMs ?? this.#defaultTimeoutMs;

          const client = await this.#connections.activate(record.serverId);

          // Propagate trace context to downstream MCP calls
          const traceHeaders: Record<string, string> = {};
          const traceContext = trace.setSpan(context.active(), span);
          propagation.inject(traceContext, traceHeaders);

          const content = await callWithTimeout(
            client.callTool(record.name, args, { headers: traceHeaders }),
            timeoutMs,
            `Tool "${record.id}" timed out after ${timeoutMs}ms`,
          );
          const durationMs = Date.now() - start;
          const respSize = safeByteLength(content);

          span.setAttribute(ACTION_HUB_ATTRIBUTES.EXECUTION_STATUS, "success");
          span.setAttribute(ACTION_HUB_ATTRIBUTES.STATUS, "ok");
          span.setAttribute(ACTION_HUB_ATTRIBUTES.EXECUTION_DURATION_MS, durationMs);
          span.setAttribute(ACTION_HUB_ATTRIBUTES.RESPONSE_PAYLOAD_SIZE_BYTES, respSize);
          // A successful downstream call proves the transport is alive: reset
          // the execute-failure streak so isolated connection failures between
          // healthy calls cannot accumulate into an open circuit.
          this.#connections.recordSuccess(record.serverId, durationMs);
          if (approved) {
            span.setAttribute(ACTION_HUB_ATTRIBUTES.APPROVAL_STATUS, "approved");
          }
          span.setStatus({ code: SpanStatusCode.OK });

          this.#record({
            actionId,
            serverId: record.serverId,
            startedAt,
            durationMs,
            ok: true,
            ...(approved ? { approval: "approved" as const } : {}),
          });
          if (cacheable) {
            const cacheKey = `${actionId}:${fingerprintArguments(args)}`;
            this.#resultCache.set(cacheKey, { content, expiresAt: Date.now() + this.#cacheTtlMs });
            while (this.#resultCache.size > this.#cacheMaxEntries) {
              const oldest = this.#resultCache.keys().next().value;
              if (oldest === undefined) break;
              this.#resultCache.delete(oldest);
            }
          }
          return { ok: true, actionId, content, durationMs };
        } catch (cause) {
          const durationMs = Date.now() - start;
          const message = cause instanceof Error ? cause.message : String(cause);
          const isTimeout = message.includes("timed out after");
          const isCircuit = message.includes("Circuit breaker open");

          // Feed transport/connection failures back into the circuit breaker.
          // reportExecuteFailure counts only errors tagged at the client
          // boundary as transport-level (see isTransportFailure): JSON-RPC
          // error responses and isError results from a live server are ignored,
          // and the breaker's recovery (drop + restart) never blocks on close.
          if (isCircuit) {
            // Already tripped; nothing to feed back.
          } else if (isTimeout) {
            // F26: consecutive execute timeouts isolate a server that hangs
            // every tools/call (a slow handler is not a transport failure,
            // so the breaker's transport path ignores these by design).
            this.#connections.recordExecuteTimeout(record.serverId, message);
          } else {
            await this.#connections.reportExecuteFailure(record.serverId, cause, message);
          }

          span.setAttribute(
            ACTION_HUB_ATTRIBUTES.EXECUTION_STATUS,
            isTimeout ? "timed_out" : "failed",
          );
          span.setAttribute(ACTION_HUB_ATTRIBUTES.STATUS, isTimeout ? "timed_out" : "error");
          span.setAttribute(ACTION_HUB_ATTRIBUTES.EXECUTION_DURATION_MS, durationMs);
          span.setAttribute(
            ACTION_HUB_ATTRIBUTES.ERROR_CODE,
            isTimeout ? "timeout" : isCircuit ? "circuit_breaker_open" : "downstream_error",
          );
          span.setAttribute(
            ACTION_HUB_ATTRIBUTES.ERROR_CLASS,
            cause instanceof Error ? cause.constructor.name : "Error",
          );
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message,
          });
          if (cause instanceof Error) {
            span.recordException(cause);
          }

          return this.#fail(
            actionId,
            record.serverId,
            message,
            startedAt,
            start,
            approved ? "approved" : undefined,
          );
        }
      },
    );
  }

  /** Clears all cached idempotent-read results. */
  clearResultCache(): void {
    this.#resultCache.clear();
  }

  /** Outstanding, unexpired approval tokens. Diagnostics only. */
  pendingApprovals(): number {
    return this.#approvals.size;
  }

  serverStates(): ServerState[] {
    return this.#connections.states();
  }

  /** Probes server health and tracks response latency. */
  async checkHealth(serverId: string): Promise<HealthCheckResult> {
    return this.#connections.checkHealth(serverId);
  }

  /** Probes all registered servers in parallel. */
  async checkAllHealth(): Promise<HealthCheckResult[]> {
    return this.#connections.checkAllHealth();
  }

  /** Reconnects a server. */
  async reconnect(serverId: string): Promise<void> {
    await this.#connections.reconnect(serverId);
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
   * single file can serve both the cache and host-side diagnostics readers.
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

async function callWithTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Search results carry a single line; full text is reserved for `load`. */
function summarize(text: string): string {
  const firstLine = text.split("\n").find((line) => line.trim().length > 0)?.trim() ?? text.trim();
  if (firstLine.length <= SUMMARY_MAX) return firstLine;
  return `${firstLine.slice(0, SUMMARY_MAX - 1).trimEnd()}…`;
}
