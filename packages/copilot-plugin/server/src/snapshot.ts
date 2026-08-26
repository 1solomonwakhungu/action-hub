import { ActionHub, CatalogCache } from "@action-hub/core";

/** stdout is the MCP channel; diagnostics must go to stderr. */
export function warn(message: string): void {
  process.stderr.write(`action-hub: ${message}\n`);
}

/**
 * Publishes the hub's state for the Capability Manager canvas, which reads this
 * file rather than connecting to anything itself.
 *
 * The snapshot and the startup cache are the same file: the persisted entry is
 * a superset of the snapshot, so writing it keeps the canvas current and the
 * cache warm in one atomic write. `CatalogCache.write` serialises concurrent
 * writes and uses a unique temp file per write, so the unawaited call after
 * every `execute` cannot corrupt the file the canvas is polling. Failures are
 * reduced to a warning — a missing diagnostics snapshot must never take down
 * the MCP server the agent depends on.
 */
export async function writeSnapshot(
  hub: ActionHub,
  configHash: string,
  cache: CatalogCache = new CatalogCache({ onWarning: warn }),
): Promise<void> {
  await cache.write(hub.toPersisted(configHash));
}
