import type { ActionRecord, ServerConfig, TrustTier } from "../types.js";
import { trustRank } from "../catalog/catalog.js";

export interface PolicyDecision {
  allowed: boolean;
  /** True when execution may proceed only after explicit user approval. */
  requiresApproval: boolean;
  reason?: string;
}

export interface PolicyOptions {
  /**
   * Minimum trust tier that may execute without approval. Actions from less
   * trusted servers are still allowed, but gated.
   */
  autoApproveAtOrAbove?: TrustTier;
}

/**
 * Decides whether an action may run, and whether it needs a human in the loop.
 *
 * The policy is intentionally conservative: anything below the auto-approve
 * threshold is gated rather than silently executed.
 */
export class PermissionPolicy {
  readonly #autoApproveFloor: number;

  constructor(options: PolicyOptions = {}) {
    this.#autoApproveFloor = trustRank(options.autoApproveAtOrAbove ?? "trusted");
  }

  evaluate(action: ActionRecord, serverConfig: ServerConfig | undefined): PolicyDecision {
    if (!serverConfig) {
      return { allowed: false, requiresApproval: false, reason: `Unknown server "${action.serverId}"` };
    }
    if (serverConfig.enabled === false) {
      return { allowed: false, requiresApproval: false, reason: `Server "${action.serverId}" is disabled` };
    }
    if (action.trust === "blocked") {
      return { allowed: false, requiresApproval: false, reason: `Action "${action.id}" is blocked by policy` };
    }
    if (!isToolPermitted(serverConfig, action.name)) {
      return {
        allowed: false,
        requiresApproval: false,
        reason: `Tool "${action.name}" is excluded by the allow/deny list for "${action.serverId}"`,
      };
    }

    const requiresApproval = trustRank(action.trust) < this.#autoApproveFloor;
    return {
      allowed: true,
      requiresApproval,
      reason: requiresApproval ? `Server "${action.serverId}" is ${action.trust}` : undefined,
    };
  }
}

/** Deny wins over allow, so an explicitly denied tool can never be reached. */
export function isToolPermitted(config: ServerConfig, toolName: string): boolean {
  if (config.denyTools?.includes(toolName)) return false;
  if (config.allowTools && config.allowTools.length > 0) {
    return config.allowTools.includes(toolName);
  }
  return true;
}
