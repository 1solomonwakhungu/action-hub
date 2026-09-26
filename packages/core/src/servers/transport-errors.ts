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
 * untouched; errors positively identified as transport are marked:
 *   - the transport closed (transportClosed), or
 *   - a known transport code/errno is found on the error itself or within a
 *     bounded cause chain (Node's fetch wraps network failures as
 *     TypeError("fetch failed") whose cause carries code="ECONNREFUSED" and
 *     a numeric errno).
 * Everything else — coded JSON-RPC errors from a live server, HTTP status
 * errors, unknown/uncoded errors — stays unmarked and never counts against
 * the breaker.
 */
export function classifyDownstreamError(cause: unknown, transportClosed: boolean): unknown {
  if (cause instanceof ToolError) return cause;
  if (transportClosed || errorHasTransportCode(cause, 0)) {
    return markTransportFailure(cause);
  }
  return cause;
}

/** Bounded walk of an error's cause chain looking for a known transport
 * code/errno. Does not infer from message text. */
export function errorHasTransportCode(cause: unknown, depth: number): boolean {
  if (depth > 3 || typeof cause !== "object" || cause === null) return false;
  const node = cause as { code?: unknown; errno?: unknown; cause?: unknown };
  if (typeof node.code === "string" && TRANSPORT_ERRNOS.has(node.code)) return true;
  if (typeof node.errno === "string" && TRANSPORT_ERRNOS.has(node.errno)) return true;
  return errorHasTransportCode(node.cause, depth + 1);
}
