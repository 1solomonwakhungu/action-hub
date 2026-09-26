/**
 * Typed, positive distinction between tool-level and transport-level
 * downstream failures (F16, FX6-R3).
 *
 * Tool-level failures (isError results, JSON-RPC error responses from a live
 * server) must NEVER count against a server's circuit breaker — a live tool
 * can throw arbitrary text like "Not connected to Slack workspace." without
 * the transport being dead. Transport-level failures (closed transport, dead
 * child, EPIPE/ECONNRESET) count.
 *
 * The rule is positive: only errors explicitly marked (adapters wrapping a
 * positively-identified transport failure via markTransportFailure) or
 * carrying a transport errno are counted. Unknown/uncoded errors are never
 * counted.
 */

/** Symbol marker for positively-identified transport-level failures. */
const TRANSPORT_FAILURE = Symbol("action-hub.transportFailure");

/** Thrown by adapters for tool-level failures: an isError result or a
 * JSON-RPC error response from a live server. Never counts against the
 * circuit breaker. */
export class ToolError extends Error {}

/** Errnos that positively identify a dead transport. */
export const TRANSPORT_ERRNOS: ReadonlySet<string> = new Set([
  "EPIPE",
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "ERR_STREAM_DESTROYED",
]);

/** Marks an error as a positively-identified transport failure. Adapters call
 * this when the transport layer (not the tool) failed. */
export function markTransportFailure<T extends unknown>(cause: T): T {
  if (cause instanceof Error) {
    try {
      (cause as unknown as Record<symbol, unknown>)[TRANSPORT_FAILURE] = true;
    } catch {
      // A frozen error cannot be tagged; the original is rethrown unchanged.
    }
  }
  return cause;
}

/** True when `cause` was positively marked as a transport-level failure. */
export function isTransportFailure(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    TRANSPORT_FAILURE in (cause as Record<symbol, unknown>)
  );
}

/**
 * Adapter-side classifier for a rejected callTool. ToolError passes through
 * untouched; errors positively identified as transport (the transport closed,
 * or a transport errno) are marked; everything else — including coded JSON-RPC
 * errors from a live server and unknown/uncoded errors — stays unmarked and
 * never counts against the breaker.
 */
export function classifyDownstreamError(cause: unknown, transportClosed: boolean): unknown {
  if (cause instanceof ToolError) return cause;
  const errno = (cause as { errno?: unknown } | null)?.errno;
  if (
    transportClosed ||
    (typeof errno === "string" && TRANSPORT_ERRNOS.has(errno))
  ) {
    return markTransportFailure(cause);
  }
  return cause;
}
