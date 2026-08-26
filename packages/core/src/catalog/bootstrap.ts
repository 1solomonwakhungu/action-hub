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
   * promise is settled by the time the caller sees it.
   */
  refreshed: Promise<IndexResult[]>;
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

  if (!entry) {
    const results = await hub.indexAll();
    await cache.write(hub.toPersisted(configHash));
    return {
      fromCache: false,
      actions: hub.catalog.size,
      configHash,
      cache,
      refreshed: Promise.resolve(results),
    };
  }

  const actions = hub.restoreCatalog(entry);

  const refreshed =
    options.refreshInBackground === false
      ? Promise.resolve<IndexResult[]>([])
      : reindexAndPersist(hub, cache, configHash, options.onWarning);

  return { fromCache: true, actions, configHash, cache, refreshed };
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
): Promise<IndexResult[]> {
  try {
    const results = await hub.indexAll();
    await cache.write(hub.toPersisted(configHash));
    return results;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    onWarning?.(`background re-index failed: ${message}`);
    return [];
  }
}
