import { createServer } from "node:http";
import { joinSession, createCanvas } from "@github/copilot-sdk/extension";
import { readState } from "./state.mjs";
import { renderPage } from "./render.mjs";

const servers = new Map();

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
  ],

  open: async (ctx) => {
    const existing = servers.get(ctx.instanceId);
    if (existing) return { title: "Capability Manager", url: existing.url };

    const entry = { state: await readState(), tab: ctx.input?.tab ?? "servers" };

    const http = createServer((req, res) => {
      if (req.url === "/state") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ...entry.state, tab: entry.tab }));
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(renderPage());
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

await joinSession({
  name: "action-hub-capability-manager",
  canvases: [canvas],
});
