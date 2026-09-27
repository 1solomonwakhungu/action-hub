import { Catalog } from "./catalog/catalog.js";
import { CATALOG_CACHE_VERSION, type PersistedCatalog } from "./catalog/persistence.js";
import { BundleRegistry, type Bundle } from "./bundles/bundles.js";
import { SearchEngine, type SemanticScorer } from "./search/search.js";
import { LocalSemanticIndex, type LocalSemanticOptions } from "./search/semantic.js";
import { EmbeddingSemanticIndex, type EmbeddingIndexOptions, type PersistedEmbeddings } from "./search/embeddings.js";
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
  /**
   * Real local embeddings (SQ4). Default: on — the model is vendored in the
   * package and loaded fully offline. Pass `null` to disable (pure lexical +
   * hashed semantic); pass options to retarget the vendored model path. If
   * the model cannot load, the hub degrades to the built-in hashed scorer
   * with a warning — search never breaks.
   */
  embeddings?: EmbeddingIndexOptions | null;
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
  /**
   * Cooperative indexing: embeds the semantic index in chunks and hands the
   * event loop back between chunks so accepted connections are served during
   * (re)indexing of large catalogs. `yieldFn` is injectable for tests.
   */
  indexing?: {
    /** Documents embedded per event-loop yield. Defaults to 500. */
    chunkSize?: number;
    /** Called between chunks. Defaults to a macrotask yield. */
    yieldFn?: () => Promise<void>;
  };
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
  #semanticIndex?: LocalSemanticIndex;
  /** Real-embedding index (SQ4); #semanticIndex only materializes as fallback. */
  readonly #embedIndex?: EmbeddingSemanticIndex;
  #embedFailed = false;
  #embedRebuild?: Promise<void>;
  readonly #semanticOptions?: LocalSemanticOptions;
  readonly #approvals: ApprovalRegistry;
  readonly #telemetry: ActionHubTelemetry;
  readonly #resultCache = new Map<string, { content: unknown; expiresAt: number }>();
  readonly #cacheEnabled: boolean;
  readonly #cacheTtlMs: number;
  readonly #cacheMaxEntries: number;
  readonly #indexChunkSize: number | undefined;
  readonly #indexYieldFn: (() => Promise<void>) | undefined;
  /** Set by close(): cancels the fire-and-forget embedding rebuild at the
   * next chunk boundary so shutdown is never held for minutes of embed work. */
  #embedCancelled = false;
  #embedWarned = false;

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
    } else if (options.embeddings === null) {
      // Embeddings explicitly disabled: keep the dependency-free hashed index.
      this.#semanticIndex = new LocalSemanticIndex(options.semantic);
      this.#search.setSemanticScorer(this.#semanticIndex.asScorer());
    } else {
      // Default: real local embeddings (SQ4). The model is vendored and loaded
      // lazily and offline; on failure the hub falls back to the hashed index
      // with a warning, so search never breaks.
      this.#semanticOptions = options.semantic;
      this.#embedIndex = new EmbeddingSemanticIndex(options.embeddings);
      this.#search.setFusion("rrf");
      this.#search.setSemanticScorer(this.#embedScorer());
      // Preload the vendored model while servers activate: the one-time load
      // (~0.3-0.6 s) then does not extend the index tail, where it would
      // otherwise race the per-server restart backoff timers (a failing
      // server retried inside a slow indexAll flips status to "degraded").
      // load() is failure-safe (returns false, warns once).
      void this.#embedIndex.load();
    }
    this.#policy = new PermissionPolicy(options.policy ?? {});
    this.#historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT;
    this.#denyOnApprovalRequired = options.denyOnApprovalRequired ?? false;
    this.#approvals = new ApprovalRegistry(options.approvals ?? {});
    this.#cacheEnabled = options.resultCache?.enabled ?? true;
    this.#cacheTtlMs = options.resultCache?.ttlMs ?? 60_000;
    this.#cacheMaxEntries = options.resultCache?.maxEntries ?? 500;
    this.#indexChunkSize = options.indexing?.chunkSize;
    this.#indexYieldFn = options.indexing?.yieldFn;
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
    // The embedding rebuild is deliberately NOT awaited here: holding the
    // index tail for the one-time model load + corpus embed extends indexAll
    // past the per-server restart backoff timers, so a server that failed
    // during indexing gets auto-retried mid-index (status flips to
    // "degraded" while indexAll is still running). With the non-blocking
    // rebuild, indexAll's duration is unchanged from the lexical-only path;
    // searches during the cold embed contribute zero semantic weight (the
    // D1-R4 boundedness contract), and hosts that need the vectors await
    // {@link semanticReady}.
    this.#kickEmbeddingRebuild();
    return results;
  }

  /**
   * Resolves when the embedding index has finished embedding the current
   * catalog (or when embeddings have permanently fallen back). Hosts and
   * tests that need warm vectors before their first search await this.
   */
  async semanticReady(): Promise<void> {
    await this.#embedRebuild;
  }

  /** Number of document vectors currently held by the embedding index
   * (diagnostics/test observability; 0 when embeddings are disabled). */
  get embeddedDocs(): number {
    return this.#embedIndex?.embeddedDocs ?? 0;
  }

  async indexServer(serverId: string): Promise<IndexResult> {
    const result = await this.#indexServer(serverId);
    this.#kickEmbeddingRebuild();
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
    // Embeddings rebuild is async (model + embedding work); chain it so a
    // sync caller (registerSkills, direct catalog mutation) still gets fresh
    // vectors. One rebuild in flight at a time; the rebuild DRAINS catalog
    // mutations: it re-runs whenever the catalog generation changed during
    // or since the last pass (packaging/review round: an in-flight rebuild
    // used to lose records registered mid-pass). Mutations that land after
    // the drain exits are picked up by the next trigger call.
    if (this.#embedIndex && !this.#embedFailed) {
      this.#embedRebuild ??= (async () => {
        // In-flight rebuild: semantic channel is zero AND fusion drops to
        // blend so in-flight searches match the pure-BM25-blend reference
        // (D1-R4 score contract). Restored to rrf in the finally below.
        this.#search.setFusion("blend");
        try {
          if (!(await this.#embedIndex!.load())) {
            this.#embedFailed = true;
            return;
          }
          for (;;) {
            const generation = this.#catalog.generation;
            // Cooperative cancellation (review-2 round 3): close() flips
            // #embedCancelled and the next chunk boundary throws, ending the
            // rebuild instead of holding shutdown open for minutes.
            const baseYield = this.#indexYieldFn;

                // Production (no test override) MUST yield a real macrotask
                // tick between chunks (review-2 round 4): `await undefined`
                // is a microtask that never services timers/signals, so the
                // event loop starves for the whole embed and close()
                // cancellation could never run.
                //
                // The default is a SINGLE-BOUNDARY timer yield: measured with
                // a 10ms heartbeat over a 300-doc rebuild, `await undefined`
                // gives 0 ticks and promise forms that chain within one loop
                // pass give ~2 ticks; exactly this form (timer awaited once,
                // directly from the yield function) services the loop every
                // chunk (~40 ticks). An extra async boundary around the
                // promise silently reverts to starvation, so keep this exact
                // shape.
                const yieldImpl =
                  baseYield ??
                  (async () => {
                    await new Promise<void>((resolve) => setTimeout(resolve, 0));
                  });
                await this.#embedIndex!.index(this.#catalog.all(), {
                  chunkSize: this.#indexChunkSize ?? 64,
                  yieldFn: async () => {
                    if (this.#embedCancelled) throw new Error("embedding rebuild cancelled by close()");
                    await yieldImpl();
                    // Re-check AFTER the yield (review-2 round 5): a close()
                    // arriving DURING the timer yield must land at this
                    // boundary — otherwise the rebuild always processes one
                    // more whole chunk before noticing.
                    if (this.#embedCancelled) throw new Error("embedding rebuild cancelled by close()");
                  },
                });
            this.#embedIndex!.prune(new Set(this.#catalog.all().map((record) => record.id)));
            if (this.#embedCancelled) break;
            if (this.#catalog.generation === generation) break;
          }
        } catch (cause) {
          if (this.#embedCancelled) {
            // Normal shutdown cancellation (review-2 round 4): NOT a failure.
            // No warn, no fallback, no discard — the partial in-memory state
            // is simply left as-is while the hub closes.
          } else {
            // Graceful fallback on ANY real rebuild failure (review-2 round 3):
            // the documented contract is "finished or permanently fallen
            // back". A PARTIAL embedding map must never serve as the semantic
            // channel (mixed coverage distorts rankings), so discard it, warn
            // once, and degrade to the hashed/blend scorer.
            this.#embedFailed = true;
            this.#embedIndex!.discardVectors();
            this.#warnOnce(
              `embedding rebuild failed; falling back to the built-in semantic scorer (${String(cause).slice(0, 200)})`,
            );
          }
        } finally {
          this.#embedRebuild = undefined;
          // Restore RRF fusion unless embeddings permanently failed (the
          // failure path keeps blend so the zero-semantic channel matches
          // the pre-SQ4 score contract, including the D1-R4 in-flight
          // rebuild window where the channel contributes exactly zero).
          if (!this.#embedFailed) this.#search.setFusion("rrf");
        }
      })();
    }
  }

  /**
   * The embeddings scorer with graceful degradation: on the first scorer call
   * the vendored model is loaded lazily (offline); if that fails, the hub
   * permanently falls back to the built-in hashed index and the fusion
   * strategy returns to score blending, so behavior matches pre-SQ4.
   */
  #embedScorer(): SemanticScorer {
    const embed = this.#embedIndex!;
    const embedScorer = embed.asScorer();
    const zeros = (n: number) => new Array<number>(n).fill(0);
    return async (query, candidates) => {
      if (this.#embedFailed) {
        return this.#fallbackScorer()(query, candidates);
      }
      // D1-R4 boundedness: while a rebuild is in flight, the semantic channel
      // contributes exactly zero AND fusion drops to blend, so a search
      // parked behind a slow rebuild never triggers embedding work and its
      // ranking/scores match the pure-BM25-blend reference exactly.
      if (this.#embedRebuild) return zeros(candidates.length);
      if (!(await embed.load())) {
        this.#embedFailed = true;
        this.#search.setFusion("blend");
        return this.#fallbackScorer()(query, candidates);
      }
      return embedScorer(query, candidates);
    };
  }

  /** Materializes (once) the hashed-index fallback after embedding failure. */
  #fallbackScorer(): SemanticScorer {
    return async (query, candidates) => {
      if (!this.#semanticIndex) {
        const local = new LocalSemanticIndex(this.#semanticOptions);
        await local.indexCooperative(this.#catalog.all(), {
          chunkSize: this.#indexChunkSize,
          yieldFn: this.#indexYieldFn,
        });
        this.#semanticIndex = local;
      }
      return this.#semanticIndex.asScorer()(query, candidates);
    };
  }

  /**
   * Cooperative variant used on the async indexing paths: same result as
   * {@link rebuildSemanticIndex}, but the event loop is served between chunks.
   */
  async #rebuildSemanticIndexCooperatively(): Promise<void> {
    if (this.#embedIndex && !this.#embedFailed) {
      // Reuse an in-flight sync-triggered rebuild, otherwise run one here.
      if (!this.#embedRebuild) this.rebuildSemanticIndex();
      await this.#embedRebuild;
    } else if (this.#semanticIndex) {
      await this.#semanticIndex.indexCooperative(this.#catalog.all(), {
        chunkSize: this.#indexChunkSize,
        yieldFn: this.#indexYieldFn,
      });
    }
  }

  /** Fire-and-forget embedding rebuild (deduplicated by #embedRebuild). */
  #kickEmbeddingRebuild(): void {
    if (this.#embedIndex && !this.#embedFailed) this.rebuildSemanticIndex();
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
          // A successful downstream call proves the transport is alive: reset
          // the execute-failure streak AND the execute-timeout streak (F26)
          // so isolated connection failures between healthy calls cannot
          // accumulate into an open circuit. Heartbeat/listTools successes
          // deliberately do NOT reset the timeout streak (recordSuccess).
          this.#connections.recordExecuteSuccess(record.serverId, durationMs);
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
          // Positive classification (F26 rework): only callWithTimeout's own
          // rejection is an execution timeout. A live server's ToolError or
          // isError text saying "timed out after..." is a TOOL error and
          // must not feed the timeout streak.
          const isTimeout = cause instanceof ExecutionTimeoutError;
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
    // SQ4: hydrate persisted document vectors so a warm start re-embeds only
    // changed documents instead of the whole corpus.
    this.#embedIndex?.hydrate(entry.embeddings);
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
      // Warm-start vectors (SQ4): persisted only when the model actually
      // loaded, so a failed/offline-model run never writes empty vectors.
      ...(this.#embedIndex?.ready ? { embeddings: this.#embedIndex.toPersisted() } : {}),
    };
  }

  async close(): Promise<void> {
    // Stop the fire-and-forget embedding rebuild first: at the measured 15K
    // cold-embed cost an unclosed rebuild would hold shutdown open for
    // minutes. Cancellation lands at the next chunk boundary (cooperative);
    // settlement is bounded so close() stays prompt even if a chunk is
    // mid-flight.
    this.#embedCancelled = true;
    const rebuild = this.#embedRebuild;
    if (rebuild) {
      // Bounded settlement. The deadline timer is unref'd (it must never
      // hold the process open) and cleared once the race settles (review-2
      // round 4: an uncleared ref'd timer delayed process exit ~2s).
      let deadline: NodeJS.Timeout | undefined;
      const timedOut = new Promise<void>((resolve) => {
        deadline = setTimeout(resolve, 2000);
        deadline.unref?.();
      });
      await Promise.race([rebuild.catch(() => {}), timedOut]);
      if (deadline) clearTimeout(deadline);
    }
    await this.#connections.closeAll();
  }

  /** Warns once per hub (stderr; MCP-safe) on embedding degradation. */
  #warnOnce(message: string): void {
    if (this.#embedWarned) return;
    this.#embedWarned = true;
    process.stderr.write(`action-hub: ${message}\n`);
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

/**
 * Positively typed Action Hub execution timeout (F26 rework): a tool error
 * or isError response whose text merely CONTAINS "timed out after" must
 * never be classified as an execution timeout — only callWithTimeout's own
 * rejection carries this type.
 */
class ExecutionTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionTimeoutError";
  }
}

async function callWithTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ExecutionTimeoutError(timeoutMessage)), timeoutMs);
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
