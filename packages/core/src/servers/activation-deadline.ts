/**
 * Shared connect-with-deadline helper for the SDK adapters (F27).
 *
 * The MCP SDK's client.connect() has no deadline parameter: a stdio child
 * that never answers initialize would hang startup forever. This races the
 * connect against the caller's activation deadline; on abort it releases the
 * spawned child with a bounded close, so a dead server can never gate hub
 * startup beyond its deadline.
 */
export async function connectWithDeadline(
  client: {
    connect(transport: unknown): Promise<void>;
    close(): Promise<void>;
  },
  transport: { close?: () => Promise<void> } | unknown,
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
    // block the failure path either.
    const bounded = <T>(p: Promise<T>, ms: number): Promise<T> =>
      Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("close timed out")), ms))]);
    try {
      await bounded(client.close(), 2_000);
    } catch {
      // Best-effort teardown; the deadline error is what matters.
    }
    throw describeCause ? describeCause(cause) : cause;
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
