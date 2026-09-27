/**
 * A cancellable one-turn-deferred callback with a shutdown guard — the
 * shared lifecycle behind the deferred authoritative refresh in BOTH serve
 * modes (FX12-R4/R5/R6): the daemon schedules it once its listener is up,
 * HTTP schedules it after a response has flushed; `close` in either mode
 * must cancel a trigger that has not run yet, and a callback that fires
 * late must re-check `isStopped` instead of starting work against a closed
 * hub. An already-STARTED refresh is awaited by `runtime.close()` (the
 * runtime memoises its refresh promise).
 */
export interface DeferredTrigger {
  /** Queues `fire` one turn from now (no-op if already queued). */
  schedule(fire: () => void): void;
  /** Cancels a queued trigger that has not run yet. Idempotent. */
  cancel(): void;
}

export function createDeferredTrigger(isStopped: () => boolean): DeferredTrigger {
  let pending: NodeJS.Immediate | undefined;
  return {
    schedule(fire: () => void): void {
      if (pending) return;
      pending = setImmediate(() => {
        pending = undefined;
        if (isStopped()) return;
        fire();
      });
    },
    cancel(): void {
      if (pending) {
        clearImmediate(pending);
        pending = undefined;
      }
    },
  };
}
