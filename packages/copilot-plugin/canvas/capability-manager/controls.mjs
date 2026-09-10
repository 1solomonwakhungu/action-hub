import { hubRequest } from "./hub.mjs";
import { readState } from "./state.mjs";

export const TRUST_TIERS = ["blocked", "untrusted", "trusted"];

/**
 * The write/test operations the canvas exposes.
 *
 * Both entry points — a canvas action invoked by the agent and a button
 * clicked in the panel — call these same functions, so there is exactly one
 * code path per control and no way for the two surfaces to diverge.
 *
 * Each operation shape-checks its arguments here purely to give a fast, local
 * error message. The hub re-validates everything it receives and is the only
 * authority: this side is untrusted input as far as the hub is concerned.
 */
export const operations = {
  set_server_enabled: async (input) => {
    const serverId = text(input?.serverId);
    if (!serverId) return fail(`"serverId" must be a non-empty string`);
    if (typeof input?.enabled !== "boolean") return fail(`"enabled" must be true or false`);
    return hubRequest("/set-enabled", { serverId, enabled: input.enabled });
  },

  set_server_trust: async (input) => {
    const serverId = text(input?.serverId);
    if (!serverId) return fail(`"serverId" must be a non-empty string`);
    if (!TRUST_TIERS.includes(input?.trust)) {
      return fail(`"trust" must be one of ${TRUST_TIERS.join(", ")}`);
    }
    return hubRequest("/set-trust", { serverId, trust: input.trust });
  },

  test_search: async (input) => {
    const query = text(input?.query);
    if (!query) return fail(`"query" must be a non-empty string`);

    const body = { query };
    if (input.limit !== undefined) body.limit = input.limit;
    if (input.serverId) body.serverId = input.serverId;
    if (input.includeSchema !== undefined) body.includeSchema = input.includeSchema;
    return hubRequest("/search", body);
  },

  reconnect_server: async (input) => {
    const serverId = text(input?.serverId);
    if (!serverId) return fail(`"serverId" must be a non-empty string`);
    return hubRequest("/reconnect", { serverId });
  },

  check_health: async (input) => {
    const serverId = text(input?.serverId);
    return hubRequest("/check-health", serverId ? { serverId } : {});
  },

  import_config: async (input) => {
    if (!input?.config) return fail(`"config" must be provided`);
    return hubRequest("/import-config", { config: input.config });
  },

  migrate_capabilities: async (input) => {
    return hubRequest("/migrate", {
      write: input?.write !== false,
      overwrite: input?.overwrite === true,
      customPaths: Array.isArray(input?.customPaths) ? input.customPaths : undefined,
    });
  },

  load_action: async (input) => {
    const actionId = text(input?.actionId);
    if (!actionId) return fail(`"actionId" must be a non-empty string`);
    return hubRequest("/load-action", { actionId });
  },

  load_bundle: async (input) => {
    const bundleId = text(input?.bundleId);
    if (!bundleId) return fail(`"bundleId" must be a non-empty string`);
    return hubRequest("/load-bundle", { bundleId });
  },

  add_server: async (input) => {
    const id = text(input?.id);
    if (!id) return fail(`"id" must be a non-empty string`);

    const transport = input?.transport;
    if (!transport || typeof transport !== "object") {
      return fail(`"transport" must be an object describing how to reach the server`);
    }

    // Only known fields are forwarded; the hub rejects anything malformed.
    const server = { id, transport };
    if (input.displayName) server.displayName = input.displayName;
    if (input.trust) server.trust = input.trust;
    if (input.enabled !== undefined) server.enabled = input.enabled;

    return hubRequest("/add-server", { server });
  },
};

/**
 * Runs an operation and refreshes the canvas's cached state on success, so the
 * next poll reflects the change without waiting for a manual refresh.
 */
export async function runOperation(name, input, entry) {
  const operation = operations[name];
  if (!operation) return fail(`Unknown operation "${name}"`);

  const result = await operation(input);

  // A read-only search leaves nothing to re-read, and a failed write leaves
  // state untouched, so only successful mutations trigger a refresh.
  if (result?.ok && name !== "test_search" && entry) {
    entry.state = await readState();
  }

  return result;
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function fail(error) {
  return { ok: false, error };
}
