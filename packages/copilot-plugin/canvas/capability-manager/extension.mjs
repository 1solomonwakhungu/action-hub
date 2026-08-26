import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { joinSession, createCanvas } from "@github/copilot-sdk/extension";
import { readState } from "./state.mjs";
import { renderPage } from "./render.mjs";
import { TRUST_TIERS, runOperation } from "./controls.mjs";
import { MAX_BODY_BYTES, validateMutationRequest } from "./request-security.mjs";

const servers = new Map();

const TRANSPORT_SCHEMA = {
  type: "object",
  description: "How to reach the server. Validated by the hub before it is saved.",
  properties: {
    type: { type: "string", enum: ["stdio", "http"] },
    command: { type: "string", description: "Executable to spawn. Required for stdio." },
    args: { type: "array", items: { type: "string" } },
    env: { type: "object", additionalProperties: { type: "string" } },
    url: { type: "string", description: "Endpoint URL. Required for http." },
    headers: { type: "object", additionalProperties: { type: "string" } },
  },
  required: ["type"],
};

/**
 * Canvas actions and in-page controls share one implementation, so an action
 * invoked by the agent and a button pressed by the user behave identically.
 */
function controlAction(name, description, inputSchema) {
  return {
    name,
    description,
    inputSchema,
    handler: async ({ instanceId, input }) => {
      const entry = servers.get(instanceId);
      if (!entry) return { ok: false, error: "Canvas is not open" };
      return runOperation(name, input ?? {}, entry);
    },
  };
}

const canvas = createCanvas({
  id: "capability-manager",
  displayName: "Capability Manager",
  description:
    "Control center for Action Hub: connected MCP servers, health and trust, indexed action counts, search testing, invocation history, and context savings.",

  inputSchema: {
    type: "object",
    properties: {
      tab: {
        type: "string",
        enum: ["servers", "actions", "search", "history"],
        description: "Which panel to show first. Defaults to servers.",
      },
    },
  },

  actions: [
    {
      name: "refresh",
      description: "Re-read Action Hub state and repaint the canvas.",
      handler: async ({ instanceId }) => {
        const entry = servers.get(instanceId);
        if (!entry) return { ok: false, error: "Canvas is not open" };
        entry.state = await readState();
        return { ok: true, servers: entry.state.servers.length, actions: entry.state.actions };
      },
    },
    {
      name: "show_tab",
      description: "Switch the visible panel.",
      inputSchema: {
        type: "object",
        properties: {
          tab: { type: "string", enum: ["servers", "actions", "search", "history"] },
        },
        required: ["tab"],
      },
      handler: async ({ instanceId, input }) => {
        const entry = servers.get(instanceId);
        if (!entry) return { ok: false, error: "Canvas is not open" };
        entry.tab = input.tab;
        return { ok: true, tab: entry.tab };
      },
    },
    controlAction(
      "set_server_enabled",
      "Enable or disable a connected server. Disabling drops its actions from the catalog; enabling re-indexes it.",
      {
        type: "object",
        properties: {
          serverId: { type: "string", description: "Id of a configured server." },
          enabled: { type: "boolean", description: "true to enable, false to disable." },
        },
        required: ["serverId", "enabled"],
      },
    ),
    controlAction(
      "set_server_trust",
      "Change a server's trust tier. blocked hides its actions, untrusted requires approval to execute, trusted auto-approves.",
      {
        type: "object",
        properties: {
          serverId: { type: "string", description: "Id of a configured server." },
          trust: { type: "string", enum: TRUST_TIERS },
        },
        required: ["serverId", "trust"],
      },
    ),
    controlAction(
      "test_search",
      "Run a real search against the hub and return the ranked candidates, exactly as the agent would receive them.",
      {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural-language description of a task." },
          limit: { type: "integer", minimum: 1, maximum: 50, description: "Default 10." },
          serverId: { type: "string", description: "Restrict the search to one server." },
        },
        required: ["query"],
      },
    ),
    controlAction(
      "add_server",
      "Register a new MCP server with the hub, persist it to the config, and index it.",
      {
        type: "object",
        properties: {
          id: { type: "string", description: "Unique server id." },
          displayName: { type: "string" },
          trust: { type: "string", enum: TRUST_TIERS, description: "Defaults to untrusted." },
          enabled: { type: "boolean", description: "Defaults to true." },
          transport: TRANSPORT_SCHEMA,
        },
        required: ["id", "transport"],
      },
    ),
  ],

  open: async (ctx) => {
    const existing = servers.get(ctx.instanceId);
    if (existing) return { title: "Capability Manager", url: existing.url };

    const entry = {
      state: await readState(),
      tab: ctx.input?.tab ?? "servers",
      token: randomBytes(32).toString("hex"),
    };

    const http = createServer((req, res) => {
      handleRequest(entry, req, res).catch((cause) => {
        // The panel must never be left hanging on a failed fetch; an error
        // body renders as an inline notice instead.
        json(res, 500, { ok: false, error: cause?.message ?? String(cause) });
      });
    });

    await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
    const { port } = http.address();

    entry.http = http;
    entry.url = `http://127.0.0.1:${port}/`;
    servers.set(ctx.instanceId, entry);

    return { title: "Capability Manager", url: entry.url };
  },

  onClose: async (ctx) => {
    const entry = servers.get(ctx.instanceId);
    if (!entry) return;
    servers.delete(ctx.instanceId);
    await new Promise((resolve) => entry.http.close(resolve));
  },
});

async function handleRequest(entry, req, res) {
  const path = (req.url ?? "/").split("?")[0];

  if (req.method === "GET" && path === "/state") {
    // Re-read on every poll so changes made through a canvas action, or by the
    // hub itself, show up without the user pressing anything.
    entry.state = await readState();
    json(res, 200, { ...entry.state, tab: entry.tab });
    return;
  }

  if (req.method === "POST" && path.startsWith("/control/")) {
    const rejection = validateMutationRequest(req, entry.token);
    if (rejection) {
      json(res, rejection.status, { ok: false, error: rejection.error });
      return;
    }
    const name = path.slice("/control/".length);
    const input = await readJsonBody(req);
    json(res, 200, await runOperation(name, input, entry));
    return;
  }

  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(renderPage(entry.token));
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body is too large");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Request body must be a JSON object");
  }
  return parsed;
}

function json(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

await joinSession({
  name: "action-hub-capability-manager",
  canvases: [canvas],
});
