/**
 * Core domain types for Action Hub.
 *
 * Nothing in this file may reference a specific agent host. The catalog,
 * search, and routing layers are intentionally host-neutral so the same
 * engine can back a Copilot plugin, a Claude Code MCP server, or any other
 * MCP-compatible client.
 */

/** JSON Schema describing an action's arguments, preserved verbatim from upstream. */
export type JsonSchema = Record<string, unknown>;

/** Where a catalog entry came from. */
export type ActionKind = "tool" | "skill";

/**
 * Trust tiers govern whether an action may execute without explicit approval.
 * Ordering is meaningful: higher tiers are strictly more permissive.
 */
export const TRUST_TIERS = ["blocked", "untrusted", "trusted"] as const;
export type TrustTier = (typeof TRUST_TIERS)[number];

export interface ServerConfig {
  /** Stable identifier, unique across the catalog. */
  id: string;
  /** Human-readable name shown in the capability manager. */
  displayName?: string;
  /** Transport used to reach the downstream server. */
  transport: StdioTransport | HttpTransport;
  /** Defaults to "untrusted" when omitted. */
  trust?: TrustTier;
  /** When false, the server is skipped entirely during indexing. */
  enabled?: boolean;
  /**
   * Optional allow-list of upstream tool names. When present, tools outside
   * this list are not indexed and cannot be executed.
   */
  allowTools?: string[];
  /** Optional deny-list applied after `allowTools`. */
  denyTools?: string[];
  /** Optional timeout in milliseconds for tool executions on this server. */
  timeoutMs?: number;
}

export interface StdioTransport {
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface HttpTransport {
  type: "http";
  url: string;
  headers?: Record<string, string>;
}

/**
 * A single searchable capability. Note that `inputSchema` is stored but is
 * never returned by search — only by an explicit `load`. Keeping schemas out
 * of search results is the entire point of the system.
 */
export interface ActionRecord {
  /** Globally unique, formatted as `<serverId>:<name>`. */
  id: string;
  kind: ActionKind;
  serverId: string;
  /** The upstream tool name, used verbatim when dispatching. */
  name: string;
  /** One-line summary returned by search. */
  summary: string;
  /** Full description, returned only by `load`. */
  description?: string;
  inputSchema?: JsonSchema;
  /** Free-form tags contributing to lexical search. */
  tags?: string[];
  trust: TrustTier;
}

export interface SearchHit {
  id: string;
  kind: ActionKind;
  serverId: string;
  name: string;
  summary: string;
  score: number;
  inputSchema?: JsonSchema;
}

export interface SearchOptions {
  limit?: number;
  /** Restrict results to specific servers. */
  serverIds?: string[];
  kind?: ActionKind;
  /** Exclude actions whose trust tier is below this. */
  minTrust?: TrustTier;
  /** When true, includes the inputSchema on retrieved hits */
  includeSchema?: boolean;
}

/** Returned by `load`; this is the only path that exposes a full schema. */
export interface LoadedAction {
  id: string;
  kind: ActionKind;
  serverId: string;
  name: string;
  summary: string;
  description?: string;
  inputSchema: JsonSchema;
  trust: TrustTier;
}

/** Returned by `loadBundle`; exposes full schemas and context savings for a compound tool suite. */
export interface LoadedBundle {
  id: string;
  displayName: string;
  description?: string;
  actions: LoadedAction[];
  totalEagerTokens: number;
  totalLazyTokens: number;
  tokensSaved: number;
}

/**
 * Returned instead of running an action when policy requires a human decision.
 *
 * This is the machine-readable half of the two-step flow: it tells the caller
 * exactly what was requested and hands back a token that authorizes one repeat
 * of the identical call.
 */
export interface ApprovalRequest {
  status: "approval_required";
  actionId: string;
  serverId: string;
  /** Upstream tool name, so the prompt can name the real operation. */
  name: string;
  trust: TrustTier;
  /** Why approval is needed, e.g. the server's trust tier. */
  reason: string;
  /** Single-use token, bound to this action and these exact arguments. */
  approvalToken: string;
  issuedAt: string;
  expiresAt: string;
  ttlMs: number;
  /** Argument names, sorted, so the caller can show scope without full values. */
  argumentKeys: string[];
  /** Human-readable preview of the argument payload. */
  argumentsSummary: string;
  /** What the caller must do next. */
  instructions: string;
}

export interface ExecuteResult {
  ok: boolean;
  actionId: string;
  /** Raw payload returned by the downstream server. */
  content?: unknown;
  error?: string;
  durationMs: number;
  /**
   * Present, with `ok: false`, when the call was gated rather than failed.
   * A caller that sees this should prompt the user, not retry.
   */
  approval?: ApprovalRequest;
}

/** One entry in the invocation history surfaced by the capability manager. */
export interface InvocationRecord {
  actionId: string;
  serverId: string;
  startedAt: string;
  durationMs: number;
  ok: boolean;
  error?: string;
  /** How the call cleared the approval gate, when one applied. */
  approval?: "required" | "approved";
}

/**
 * Minimal contract Action Hub needs from a downstream MCP server. Keeping
 * this narrow means the transport implementation can be swapped (real MCP
 * client, in-memory fake, recorded fixture) without touching the router.
 */
export interface McpClient {
  listTools(): Promise<Array<{ name: string; description?: string; inputSchema?: JsonSchema }>>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

/** Factory used by the connection manager to create clients lazily. */
export type McpClientFactory = (config: ServerConfig) => Promise<McpClient>;

export type ServerStatus =
  | "inactive"
  | "connecting"
  | "ready"
  | "error"
  | "disabled"
  | "degraded"
  | "unreachable"
  | "reconnecting";

export interface ServerState {
  id: string;
  displayName: string;
  status: ServerStatus;
  trust: TrustTier;
  toolCount: number;
  error?: string;
  lastActivatedAt?: string;
  latencyMs?: number;
  circuitOpen?: boolean;
}

export interface HealthCheckResult {
  serverId: string;
  status: ServerStatus;
  latencyMs?: number;
  error?: string;
}
