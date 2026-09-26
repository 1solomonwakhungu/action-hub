import type { Bundle } from "./bundles/bundles.js";
import type { OAuthClientConfig } from "./auth/types.js";

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
  /** Per-server circuit breaker. Overrides hub defaults when set. */
  circuitBreaker?: CircuitBreakerConfig;
  /** Per-server restart backoff for crashed or unreachable servers. */
  restartBackoff?: RestartBackoffConfig;
  /** Periodic liveness probe for an activated server. */
  heartbeat?: HeartbeatConfig;
  /**
   * Heap cap in megabytes for Node-based stdio servers, applied as
   * `--max-old-space-size`. Ignored for non-Node commands.
   */
  maxOldSpaceSizeMb?: number;
}

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerConfig {
  /** Consecutive failures before the circuit opens. Default 3. */
  failureThreshold?: number;
  /** Milliseconds to fail fast before a half-open probe. Default 10_000. */
  cooldownMs?: number;
}

export interface RestartBackoffConfig {
  /** First restart delay in milliseconds. Default 250. */
  initialMs?: number;
  /** Upper bound for the delay, in milliseconds. Default 30_000. */
  maxMs?: number;
  /** 0–1. Share of the delay that can be randomized. Default 0.2. */
  jitter?: number;
}

export interface HeartbeatConfig {
  /** Default true once a server is connected. */
  enabled?: boolean;
  /** Time between probes in milliseconds. Default 30_000. */
  intervalMs?: number;
  /** Probe timeout in milliseconds. Default 5_000. */
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
  /**
   * Static headers sent on every request. Still the right choice for a
   * long-lived personal access token; `auth` supersedes the `Authorization`
   * header when both are present.
   */
  headers?: Record<string, string>;
  /**
   * OAuth 2.0 credentials for this endpoint. When set, the host obtains a
   * valid access token before connecting and refreshes it on expiry or 401
   * without any further manual entry.
   */
  auth?: OAuthClientConfig;
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
  /** Declared by the upstream server (or source) as side-effect free. */
  readOnly?: boolean;
}

/** Configuration for the idempotent-read result cache. */
export interface ResultCacheOptions {
  enabled?: boolean;
  ttlMs?: number;
  maxEntries?: number;
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
  /** True when the result was served from the idempotent-read cache. */
  cached?: boolean;
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
  /** True when the invocation was served from the idempotent-read cache. */
  cached?: boolean;
}

/** Options passed to downstream MCP tool calls, including propagated trace headers. */
export interface CallToolOptions {
  headers?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * Minimal contract Action Hub needs from a downstream MCP server. Keeping
 * this narrow means the transport implementation can be swapped (real MCP
 * client, in-memory fake, recorded fixture) without touching the router.
 */
export interface McpClient {
  listTools(options?: CallToolOptions): Promise<Array<{ name: string; description?: string; inputSchema?: JsonSchema }>>;
  callTool(name: string, args: Record<string, unknown>, options?: CallToolOptions): Promise<unknown>;
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
  circuitState?: CircuitState;
  consecutiveFailures?: number;
  restartAttempt?: number;
  nextRestartAt?: string;
  lastHeartbeatAt?: string;
  memoryLimitMb?: number;
}

export interface HealthCheckResult {
  serverId: string;
  status: ServerStatus;
  latencyMs?: number;
  error?: string;
  circuitState?: CircuitState;
}

/** Configuration for an imported or defined skill. */
export interface SkillConfig {
  id: string;
  name: string;
  summary: string;
  description: string;
  tags?: string[];
  trust?: TrustTier;
  sourcePath?: string;
  sourceClient?: string;
}

export interface DiscoveredServer extends ServerConfig {
  sourcePath: string;
  sourceClient:
    | "claude-desktop"
    | "cursor"
    | "vscode"
    | "copilot"
    | "codex"
    | "windsurf"
    | "cline"
    | "roo-code"
    | "custom";
}

export interface DiscoveredSkill extends SkillConfig {
  sourcePath: string;
  sourceClient: "copilot" | "claude" | "cursor" | "agents" | "custom";
}

export interface DiscoveredPlugin {
  id: string;
  name: string;
  description?: string;
  version?: string;
  manifestPath: string;
  servers: ServerConfig[];
  skills: SkillConfig[];
}

export interface MigrationPlan {
  serversToAdd: ServerConfig[];
  serversToUpdate: ServerConfig[];
  skillsToAdd: SkillConfig[];
  skillsToUpdate: SkillConfig[];
  bundlesToAdd: Bundle[];
  conflicts: Array<{ type: "server" | "skill" | "bundle"; id: string; reason: string }>;
  summary: {
    mcpsDiscovered: number;
    mcpsAdded: number;
    skillsDiscovered: number;
    skillsAdded: number;
    pluginsDiscovered: number;
    bundlesAdded: number;
  };
}
