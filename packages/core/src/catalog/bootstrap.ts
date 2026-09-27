import type { ActionHub, IndexResult } from "../action-hub.js";
import { CatalogCache, hashServerConfigs, type CatalogCacheOptions } from "./persistence.js";
import type { ServerConfig } from "../types.js";

export interface BootstrapOptions extends CatalogCacheOptions {
  servers: readonly ServerConfig[];
  cache?: CatalogCache;
  /**
   * When true, a cache hit still triggers a full re-index, just off the
   * critical path. Set false to make a hit terminal.
   */
  refreshInBackground?: boolean;
  /**
   * When true, a cache hit serves the persisted catalog immediately and the
   * authoritative re-index is NOT started. The host starts it via
   * `startRefresh()` once it is ready — e.g. after the MCP server has
   * answered initialize. Until then `refreshed` stays pending, so a host
   * that never starts the refresh must not await `refreshed`.
   *
   * The point is startup latency: the eager refresh monopolises the event
   * loop before the server can answer its first request (measured ~2 s at
   * 15K actions), making a warm start indistinguishable from a cold one.
   */
  deferRefresh?: boolean;
}

export interface BootstrapResult {
  /** Whether the catalog was served from disk rather than a live index. */
  fromCache: boolean;
  /** Number of actions available once `bootstrapCatalog` resolves. */
  actions: number;
  configHash: string;
  cache: CatalogCache;
  /**
   * Resolves when the authoritative index has completed and been written back.
   * On a cache miss this is already the work that produced the catalog, so the
   * promise is settled by the time the caller sees it. In deferred mode it
   * stays pending until `startRefresh()` is called.
   */
  refreshed: Promise<IndexResult[]>;
  /**
   * Starts the deferred refresh exactly once; later calls return the same
   * promise. In non-deferred modes the refresh is already running (or already
   * finished) and this is equivalent to awaiting `refreshed`.
   */
  startRefresh(): Promise<IndexResult[]>;
  /**
   * F69: stable drain for the post-embedding vector write. Resolves only
   * when QUIESCENT: the current write has settled, any refresh that has
   * been started has settled (so a write it schedules is covered), and no
   * newer write was scheduled meanwhile. The promise never rejects — a
   * failure is surfaced via `onWarning` (the next re-index re-embeds).
   * Shutdown paths await this (bounded) so a pending `cache.json.tmp`
   * rename cannot outlive close.
   *
   * A never-started deferred refresh counts as quiescent (no write can
   * appear from a refresh the host never starts); a host that starts the
   * refresh after draining races its own shutdown. The plugin runtime's
   * close() awaits `startedRefresh` BEFORE draining, which makes its drain
   * cover every write.
   */
  vectorsWritten(): Promise<void>;
}

/**
 * Startup path for the catalog.
 *
 * On a hit the hub is usable immediately and the real index runs behind it,
 * writing the refreshed catalog back. On a miss — or any cache failure — this
 * degrades to exactly the previous behaviour: a full, blocking index.
 *
 * The refresh promise is always returned rather than left floating so a host
 * can await it during shutdown and tests can be deterministic.
 */
export async function bootstrapCatalog(
  hub: ActionHub,
  options: BootstrapOptions,
): Promise<BootstrapResult> {
  const cache =
    options.cache ??
    new CatalogCache({
      path: options.path,
      env: options.env,
      onWarning: options.onWarning,
    });
  const configHash = hashServerConfigs(options.servers);

  const entry = await cache.load(configHash);

  // F69: the post-semantic vector write is tracked, not fire-and-forget —
  // every scheduling site records its promise here. vectorsWritten() drains
  // it until QUIESCENT: it awaits the current write, then (if a refresh has
  // been started but not yet settled) waits for that refresh so a write
  // scheduled by it is covered too, looping until no newer write appeared.
  // A never-started deferred refresh is treated as quiescent: no write can
  // appear from a refresh the host never starts (a host that starts one
  // later races its own shutdown). Lifecycle-correct callers await
  // refreshed/startRefresh before draining — the plugin runtime's close()
  // does exactly that.
  let vectorsGeneration = 0;
  let pendingVectors: Promise<void> = Promise.resolve();
  let refreshStarted = false;
  let refreshSettled: Promise<void> = Promise.resolve();
  const recordVectorsWrite = (promise: Promise<void>): void => {
    vectorsGeneration += 1;
    pendingVectors = promise;
  };
  const vectorsWritten = (): Promise<void> =>
    (async () => {
      for (;;) {
        const generation = vectorsGeneration;
        const current = pendingVectors;
        await current;
        if (refreshStarted) await refreshSettled;
        if (vectorsGeneration === generation) return; // quiescent
      }
    })();

  if (!entry) {
    const results = await hub.indexAll();
    await cache.write(hub.toPersisted(configHash));
    recordVectorsWrite(persistVectorsWhenReady(hub, cache, configHash, options.onWarning));
    return {
      fromCache: false,
      actions: hub.catalog.size,
      configHash,
      cache,
      refreshed: Promise.resolve(results),
      startRefresh: () => Promise.resolve(results),
      vectorsWritten,
    };
  }

  const actions = hub.restoreCatalog(entry);

  if (options.deferRefresh) {
    let started: Promise<IndexResult[]> | undefined;
    let settleRefreshed!: (value: IndexResult[]) => void;
    const refreshed = new Promise<IndexResult[]>((resolve) => {
      settleRefreshed = resolve;
    });
    const startRefresh = (): Promise<IndexResult[]> => {
      // reindexAndPersist never rejects (failures become warnings), so the
      // refreshed promise only needs the fulfilment path.
      refreshStarted = true;
      refreshSettled = (
        started ??= reindexAndPersist(hub, cache, configHash, options.onWarning, recordVectorsWrite).then((results) => {
        settleRefreshed(results);
        return results;
      })).then(() => undefined);
      return started;
    };
    return { fromCache: true, actions, configHash, cache, refreshed, startRefresh, vectorsWritten };
  }

  const refreshed =
    options.refreshInBackground === false
      ? Promise.resolve<IndexResult[]>([])
      : reindexAndPersist(hub, cache, configHash, options.onWarning, recordVectorsWrite);
  refreshStarted = options.refreshInBackground !== false;
  refreshSettled = refreshed.then(() => undefined);

  return { fromCache: true, actions, configHash, cache, refreshed, startRefresh: () => refreshed, vectorsWritten };
}

/**
 * SQ4: after the embedding rebuild drains, re-persist the catalog so the
 * document vectors land in the cache. Kept OFF the startup critical path, but
 * no longer fire-and-forget (F69): the returned promise is tracked by the
 * bootstrap result so hosts can drain it during shutdown — a pending
 * cache.json.tmp rename used to outlive close() (post-close ENOENT). The
 * promise never rejects: a failure is surfaced via `onWarning` and the next
 * re-index re-embeds.
 */
function persistVectorsWhenReady(
  hub: ActionHub,
  cache: CatalogCache,
  configHash: string,
  onWarning?: (message: string) => void,
): Promise<void> {
  return hub
    .semanticReady()
    .then(async () => {
      await cache.write(hub.toPersisted(configHash));
    })
    .catch((cause: unknown) => {
      const message = cause instanceof Error ? cause.message : String(cause);
      onWarning?.(`post-embedding cache write failed: ${message}`);
    });
}

/**
 * A background refresh that rejects would surface as an unhandled rejection
 * and kill the process, so failures are reduced to a warning. The stale
 * catalog remains serviceable in the meantime.
 */
async function reindexAndPersist(
  hub: ActionHub,
  cache: CatalogCache,
  configHash: string,
  onWarning?: (message: string) => void,
  recordVectorsWrite?: (promise: Promise<void>) => void,
): Promise<IndexResult[]> {
  try {
    const results = await hub.indexAll();
    await cache.write(hub.toPersisted(configHash));
    // SQ4: indexAll returns before the (off-critical-path) embedding rebuild
    // finishes, so this first write carries no vectors. Re-persist once the
    // rebuild drains so a warm start hydrates them instead of re-embedding.
    // F69: the write promise is recorded on the bootstrap result so shutdown
    // can drain it (bounded) instead of leaving it fire-and-forget.
    recordVectorsWrite?.(persistVectorsWhenReady(hub, cache, configHash, onWarning));
    return results;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    onWarning?.(`background re-index failed: ${message}`);
    return [];
  }
}
