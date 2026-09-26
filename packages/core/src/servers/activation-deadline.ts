/**
 * Shared connect-with-deadline helper for the SDK adapters (F27).
 *
 * The MCP SDK's client.connect() has no deadline parameter: a stdio child
 * that never answers initialize would hang startup forever. This races the
 * connect against the caller's activation deadline; on abort it releases the
 * spawned child with a bounded close, so a dead server can never gate hub
 * startup beyond its deadline. The close timer is cleared and unref'd: a
 * fast-failing server must not hold a short-lived CLI process open.
 */
export async function connectWithDeadline(
  client: {
    connect(transport: unknown): Promise<void>;
    close(): Promise<void>;
  },
  transport: { close?: () => Promise<void> },
  signal: AbortSignal | undefined,
  describeCause?: (cause: unknown) => unknown,
): Promise<void> {
  if (!signal) {
    try {
      await client.connect(transport);
      return;
    } catch (cause) {
      throw describeCause ? describeCause(cause) : cause;
    }
  }
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Activation aborted");
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () =>
      reject(signal.reason instanceof Error ? signal.reason : new Error("Activation aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([client.connect(transport), aborted]);
  } catch (cause) {
    // Release the (possibly half-spawned) child with a bounded close, then
    // surface the original cause. A transport that never closes must not
    // block the failure path either — and must not leak its timer.
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const bounded = (p: Promise<void> | undefined, ms: number): Promise<void> =>
      Promise.race([
        p ?? Promise.resolve(),
        new Promise<never>((_, reject) => {
          closeTimer = setTimeout(() => reject(new Error("close timed out")), ms);
          closeTimer.unref?.();
        }),
      ]);
    try {
      // client.close() on a half-connected SDK client is a no-op — the
      // TRANSPORT owns the spawned child, so close it too.
      await bounded(client.close(), 2_000);
      await bounded(transport.close?.(), 1_000);
    } catch {
      // Best-effort teardown; the abort cause is what matters.
    } finally {
      if (closeTimer !== undefined) clearTimeout(closeTimer);
    }
    throw describeCause ? describeCause(cause) : cause;
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
