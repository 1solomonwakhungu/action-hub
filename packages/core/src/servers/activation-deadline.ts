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
    // surface the original cause. Each bounded call gets its OWN finally-
    // cleared, unref'd timer, and transport.close is attempted
    // INDEPENDENTLY: client.close() on a half-connected SDK client is a
    // no-op (and may reject) while the transport owns the spawned child.
    const boundedClose = async (p: Promise<void> | undefined, ms: number): Promise<void> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          p ?? Promise.resolve(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("close timed out")), ms);
            timer.unref?.();
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    };
    try {
      await boundedClose(client.close(), 2_000);
    } catch {
      // Best-effort teardown; the abort cause is what matters.
    }
    try {
      await boundedClose(transport.close?.(), 1_000);
    } catch {
      // Same best-effort contract.
    }
    throw describeCause ? describeCause(cause) : cause;
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
