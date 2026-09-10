export const DEFAULT_BACKOFF_INITIAL_MS = 250;
export const DEFAULT_BACKOFF_MAX_MS = 30_000;
export const DEFAULT_BACKOFF_JITTER = 0.2;

export interface RestartBackoffInput {
  /** Zero-based failed-attempt count. */
  attempt: number;
  initialMs?: number;
  maxMs?: number;
  /** 0–1. `0` is deterministic; `1` spans `[0, bound]`. */
  jitter?: number;
  /** Deterministic `[0, 1]` source for tests. */
  random?: () => number;
}

/**
 * Bounded exponential backoff with jitter.
 *
 * `bound = min(maxMs, initialMs * 2^attempt)`, then the delay is sampled from
 * `[bound * (1 - jitter), bound]`. The result is never negative and never
 * exceeds `maxMs`.
 */
export function computeRestartBackoffMs(input: RestartBackoffInput): number {
  const attempt = Math.max(0, Math.floor(input.attempt));
  const initialMs = Math.max(0, input.initialMs ?? DEFAULT_BACKOFF_INITIAL_MS);
  const maxMs = Math.max(0, input.maxMs ?? DEFAULT_BACKOFF_MAX_MS);
  const jitter = clamp(input.jitter ?? DEFAULT_BACKOFF_JITTER, 0, 1);
  const sample = clamp((input.random ?? Math.random)(), 0, 1);

  const bound = Math.min(maxMs, initialMs * 2 ** attempt);
  const floor = bound * (1 - jitter);
  return Math.min(maxMs, Math.max(0, floor + (bound - floor) * sample));
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
