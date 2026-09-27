import { ActionHub, CatalogCache } from "@action-hub/core";

/** stdout is the MCP channel; diagnostics must go to stderr. */
export function warn(message: string): void {
  process.stderr.write(`action-hub: ${message}\n`);
}

/**
 * Publishes the hub's state as a diagnostics file that hosts and tools can
 * read without connecting to the server itself.
 *
 * The snapshot and the startup cache are the same file: the persisted entry is
 * a superset of the snapshot, so writing it keeps the diagnostics current and the
 * cache warm in one atomic write. `CatalogCache.write` serialises concurrent
 * writes and uses a unique temp file per write, so the unawaited call after
 * every `execute` cannot corrupt the file a reader is polling. Failures are
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

/**
 * Coalesces post-execute snapshot writes (stress finding F18 part 2).
 *
 * Every `execute` used to fire an unawaited `writeSnapshot`, which rewrites
 * the whole persisted catalog (megabytes at full scale) once per call. This
 * debouncer marks the snapshot dirty and schedules at most one write per
 * minimum interval; bursts within the window collapse into a single write.
 * `dispose()` flushes the latest state synchronously on shutdown so a burst
 * of executes followed by an immediate exit still persists the final state.
 *
 * Writes are chained on one promise so they can never interleave; the
 * underlying `CatalogCache.write` is already atomic (temp file + rename).
 */
export class SnapshotDebouncer {
  readonly #write: () => Promise<void>;
  readonly #minIntervalMs: number;
  #dirty = false;
  #timer: NodeJS.Timeout | undefined;
  #lastWriteAt = Date.now();
  #chain: Promise<void> = Promise.resolve();
  #disposed = false;
  #drainRounds = 0;

  constructor(write: () => Promise<void>, minIntervalMs = 5000) {
    this.#write = write;
    this.#minIntervalMs = Math.max(0, minIntervalMs);
  }

  /** Marks the on-disk snapshot stale; schedules one write inside the window. */
  markDirty(): void {
    if (this.#disposed) return;
    this.#dirty = true;
    if (this.#timer) return;
    const delay = Math.max(0, this.#lastWriteAt + this.#minIntervalMs - Date.now());
    const timer = setTimeout(() => {
      this.#timer = undefined;
      void this.flush();
    }, delay);
    // Never hold the process open for a diagnostics write.
    timer.unref?.();
    this.#timer = timer;
  }

  /** Writes now if dirty; concurrent/rapid flushes serialise, latest state wins. */
  async flush(): Promise<void> {
    if (this.#disposed || !this.#dirty) return this.#chain;
    this.#dirty = false;
    this.#lastWriteAt = Date.now();
    const write = this.#write;
    this.#chain = this.#chain.then(write, write);
    await this.#chain;
  }

  /** Flushes any pending snapshot and stops scheduling. Idempotent.
   *
   *  Drains ALL accepted dirty state: a `markDirty` that lands while a flush
   *  is still in flight is persisted by the next drain round, so shutdown can
   *  never drop dirty state it has already accepted (F18 rework). Once
   *  disposal completes, further marks are ignored.
   */
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    for (;;) {
      // Drain: a mark accepted during the in-flight write below must not be
      // left to an unref'd timer nobody will wait for.
      if (this.#timer) {
        clearTimeout(this.#timer);
        this.#timer = undefined;
      }
      await this.flush();
      if (!this.#dirty) break;
      if (this.#drainRounds++ > 1000) break; // pathological-writer guard
    }
    this.#disposed = true;
  }
}
