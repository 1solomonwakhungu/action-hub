#!/usr/bin/env node
/**
 * stress/asof-fixture-server.mjs: deterministic stdio MCP test double for
 * stress/eval-asof-execution.mjs.
 *
 * Serves the tool catalog in stress/fixtures/asof-revenue.json and OWNS the
 * as-of logic: the filing with the latest acceptedDate on or before `asOf`
 * (inclusive) wins; no such filing returns an explicit
 * `{ status: "no_data", value: null, sourceId: null }`. An unknown entity is
 * a tool error (isError). Action Hub never computes any of this; the eval
 * grades only that Action Hub routes to this tool and carries arguments and
 * results through intact.
 *
 * Every response echoes the exact arguments the server received under
 * `received`, so the eval can check argument fidelity on the far side of the
 * real JSON-RPC transport. Payloads travel as JSON in a text content block
 * (Action Hub's SDK adapters forward `content`, not `structuredContent`).
 *
 * No clock, no randomness, no network, no file writes.
 *
 * Usage: node stress/asof-fixture-server.mjs [--fixture <path>]
 * Importing this module does not start the server (argv-guarded); the pure
 * `answer` function is exported for unit tests.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DEFAULT_FIXTURE = resolve(fileURLToPath(import.meta.url), "..", "fixtures", "asof-revenue.json");

export function loadFixture(path = DEFAULT_FIXTURE) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Latest filing for `metric` accepted on or before `asOf` (YYYY-MM-DD strings compare lexically). */
function asOfFiling(filings, metric, asOf) {
  let best = null;
  for (const f of filings) {
    if (f.metric !== metric || f.acceptedDate > asOf) continue;
    if (best === null || f.acceptedDate > best.acceptedDate) best = f;
  }
  return best;
}

function latestFiling(filings, metric) {
  return asOfFiling(filings, metric, "9999-12-31");
}

/**
 * Pure tool semantics. Returns `{ isError, payload }`; the payload always
 * carries `received` (the arguments exactly as delivered).
 */
export function answer(fixture, name, args) {
  const received = args ?? {};
  const entity = fixture.entities[received.entity];
  if (!fixture.tools.some((t) => t.name === name)) {
    return { isError: true, payload: { status: "error", error: `unknown tool "${name}"`, received } };
  }
  if (!entity) {
    return { isError: true, payload: { status: "error", error: `unknown entity ${JSON.stringify(received.entity)}`, received } };
  }
  const pointInTime = (metric) => {
    const f = asOfFiling(entity.filings, metric, received.asOf);
    if (f === null) {
      return {
        status: "no_data",
        entity: received.entity,
        metric,
        asOf: received.asOf,
        value: null,
        sourceId: null,
        reason: `no ${metric} filing accepted on or before ${received.asOf}`,
        received,
      };
    }
    return { status: "ok", entity: received.entity, metric, asOf: received.asOf, value: f.value, unit: f.unit, sourceId: f.id, acceptedDate: f.acceptedDate, received };
  };
  switch (name) {
    case "get_revenue_as_of":
      return { isError: false, payload: pointInTime("revenue") };
    case "get_net_income_as_of":
      return { isError: false, payload: pointInTime("net_income") };
    case "get_latest_revenue": {
      const f = latestFiling(entity.filings, "revenue");
      return {
        isError: false,
        payload: f === null
          ? { status: "no_data", entity: received.entity, metric: "revenue", value: null, sourceId: null, received }
          : { status: "ok", entity: received.entity, metric: "revenue", value: f.value, unit: f.unit, sourceId: f.id, acceptedDate: f.acceptedDate, received },
      };
    }
    case "list_filings": {
      const from = received.from ?? "0000-01-01";
      const to = received.to ?? "9999-12-31";
      const ids = [...new Set(entity.filings.filter((f) => f.acceptedDate >= from && f.acceptedDate <= to).map((f) => `${f.id}@${f.acceptedDate}`))];
      return { isError: false, payload: { status: "ok", entity: received.entity, filings: ids, received } };
    }
    default:
      return { isError: true, payload: { status: "error", error: `tool "${name}" has no fixture semantics`, received } };
  }
}

async function serve(fixture) {
  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { CallToolRequestSchema, ListToolsRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");
  const server = new Server({ name: fixture.serverId, version: "0.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: fixture.tools.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { isError, payload } = answer(fixture, request.params.name, request.params.arguments);
    return { content: [{ type: "text", text: JSON.stringify(payload) }], ...(isError ? { isError: true } : {}) };
  });
  const transport = new StdioServerTransport();
  transport.onclose = () => process.exit(0);
  await server.connect(transport);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const i = process.argv.indexOf("--fixture");
  const path = i !== -1 && process.argv[i + 1] ? resolve(process.argv[i + 1]) : DEFAULT_FIXTURE;
  serve(loadFixture(path)).catch((err) => {
    process.stderr.write(`asof-fixture-server: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exitCode = 1;
  });
}
