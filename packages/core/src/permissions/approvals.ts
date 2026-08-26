import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { ApprovalRequest, TrustTier } from "../types.js";

/** Short by design: an approval is a decision about *now*, not a standing grant. */
export const DEFAULT_APPROVAL_TTL_MS = 5 * 60_000;

const DEFAULT_MAX_PENDING = 64;
const TOKEN_BYTES = 24;

export interface ApprovalRegistryOptions {
  /** Lifetime of an issued token. Defaults to five minutes. */
  ttlMs?: number;
  /** Upper bound on outstanding tokens, so a looping model cannot grow the map without bound. */
  maxPending?: number;
  /** Injectable clock, used by tests. */
  now?: () => number;
}

export interface IssueParams {
  actionId: string;
  serverId: string;
  name: string;
  trust: TrustTier;
  reason: string;
  args: Record<string, unknown>;
}

export type ApprovalRejection =
  | "unknown_token"
  | "expired"
  | "action_mismatch"
  | "arguments_mismatch";

export interface ApprovalCheck {
  ok: boolean;
  code?: ApprovalRejection;
  reason?: string;
}

interface PendingApproval {
  actionId: string;
  serverId: string;
  fingerprint: string;
  issuedAt: number;
  expiresAt: number;
}

/**
 * Issues and redeems one-shot approval tokens.
 *
 * A token is bound to the exact action *and* the exact arguments it was issued
 * for. Approving "post a message saying hello to #general" must not become
 * authority to post anything else, so the binding is a hash of the canonical
 * argument payload rather than a per-action or per-server flag.
 *
 * Tokens are single-use and short-lived: consuming one removes it, so a
 * repeated execute call is gated again.
 */
export class ApprovalRegistry {
  readonly #pending = new Map<string, PendingApproval>();
  readonly #ttlMs: number;
  readonly #maxPending: number;
  readonly #now: () => number;

  constructor(options: ApprovalRegistryOptions = {}) {
    this.#ttlMs = options.ttlMs && options.ttlMs > 0 ? options.ttlMs : DEFAULT_APPROVAL_TTL_MS;
    this.#maxPending = options.maxPending && options.maxPending > 0 ? options.maxPending : DEFAULT_MAX_PENDING;
    this.#now = options.now ?? (() => Date.now());
  }

  get ttlMs(): number {
    return this.#ttlMs;
  }

  /** Number of outstanding, unexpired tokens. */
  get size(): number {
    this.#prune();
    return this.#pending.size;
  }

  issue(params: IssueParams): ApprovalRequest {
    this.#prune();
    this.#evictIfFull();

    const token = randomBytes(TOKEN_BYTES).toString("base64url");
    const issuedAt = this.#now();
    const expiresAt = issuedAt + this.#ttlMs;

    this.#pending.set(token, {
      actionId: params.actionId,
      serverId: params.serverId,
      fingerprint: fingerprintArguments(params.args),
      issuedAt,
      expiresAt,
    });

    return {
      status: "approval_required",
      actionId: params.actionId,
      serverId: params.serverId,
      name: params.name,
      trust: params.trust,
      reason: params.reason,
      approvalToken: token,
      issuedAt: new Date(issuedAt).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
      ttlMs: this.#ttlMs,
      argumentKeys: Object.keys(params.args).sort(),
      argumentsSummary: summarizeArguments(params.args),
      instructions:
        "Do not retry automatically. Show the user the server, action, and arguments above, " +
        "ask them to confirm, and only if they agree repeat the identical execute call with " +
        "this approval_token. The token is single-use and only valid for these exact arguments.",
    };
  }

  /**
   * Redeems a token for one execution.
   *
   * Every mismatch is a rejection, never a downgrade: a token for a different
   * action or different arguments buys nothing.
   */
  consume(token: string, actionId: string, args: Record<string, unknown>): ApprovalCheck {
    this.#prune();

    const entry = this.#pending.get(token);
    if (!entry) {
      return { ok: false, code: "unknown_token", reason: "Approval token is unknown, already used, or expired" };
    }
    if (entry.expiresAt <= this.#now()) {
      this.#pending.delete(token);
      return { ok: false, code: "expired", reason: "Approval token has expired" };
    }
    if (entry.actionId !== actionId) {
      return {
        ok: false,
        code: "action_mismatch",
        reason: `Approval token was issued for "${entry.actionId}", not "${actionId}"`,
      };
    }
    if (!sameFingerprint(entry.fingerprint, fingerprintArguments(args))) {
      return {
        ok: false,
        code: "arguments_mismatch",
        reason: "Approval token was issued for different arguments",
      };
    }

    this.#pending.delete(token);
    return { ok: true };
  }

  /** Invalidates every outstanding token. Used when policy or config changes. */
  clear(): void {
    this.#pending.clear();
  }

  #prune(): void {
    const now = this.#now();
    for (const [token, entry] of this.#pending) {
      if (entry.expiresAt <= now) this.#pending.delete(token);
    }
  }

  #evictIfFull(): void {
    while (this.#pending.size >= this.#maxPending) {
      const oldest = this.#pending.keys().next();
      if (oldest.done) return;
      this.#pending.delete(oldest.value);
    }
  }
}

/**
 * Stable, order-independent hash of an argument payload.
 *
 * Key order is normalized so `{a, b}` and `{b, a}` approve the same call, while
 * any change to a value produces a different digest.
 */
export function fingerprintArguments(args: Record<string, unknown>): string {
  return createHash("sha256").update(stableStringify(args)).digest("hex");
}

function sameFingerprint(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function stableStringify(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
  }
  if (value === undefined) return "undefined";
  return JSON.stringify(value) ?? "null";
}

const VALUE_PREVIEW_MAX = 120;
const SUMMARY_MAX = 600;

/**
 * A human-readable one-liner for the confirmation prompt.
 *
 * Values are previewed rather than dumped: the user needs to see what is being
 * requested, not a wall of payload.
 */
export function summarizeArguments(args: Record<string, unknown>): string {
  const keys = Object.keys(args);
  if (keys.length === 0) return "(no arguments)";

  const rendered = keys
    .sort()
    .map((key) => `${key}=${previewValue(args[key])}`)
    .join(", ");
  return rendered.length <= SUMMARY_MAX ? rendered : `${rendered.slice(0, SUMMARY_MAX - 1)}…`;
}

function previewValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(truncate(value));
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.length} item${value.length === 1 ? "" : "s"}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    return `{${keys.slice(0, 5).join(", ")}${keys.length > 5 ? ", …" : ""}}`;
  }
  return truncate(String(value));
}

function truncate(value: string): string {
  return value.length <= VALUE_PREVIEW_MAX ? value : `${value.slice(0, VALUE_PREVIEW_MAX - 1)}…`;
}
