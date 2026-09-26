/**
 * k6 HTTP load profile against the Action Hub MCP server (builder-10,
 * stress/external/). Streamable HTTP transport: POST <URL>/mcp JSON-RPC,
 * bearer-token auth.
 *
 * Mix (per contract R1): initialize, tools/list, action_hub search (random
 * seeded queries), load, execute.
 *
 * Scenarios (default, per intake):
 *   ramp  — 100 → 500 VUs, 100 VU steps, 30s per step
 *   soak  — 100 VUs for 5 minutes
 *
 * Tunable via env (all optional):
 *   K6_URL        http://127.0.0.1:41711   (no trailing slash)
 *   K6_TOKEN      bearer token (ACTION_HUB_HTTP_TOKEN value)
 *   K6_QUERIES    path to a JSON array of search query strings
 *   K6_ACTIONS    path to a JSON array of action_id strings for load/execute
 *   K6_PROFILE    "full" (ramp+soak, default) | "quick" (tiny smoke profile)
 *
 * Run:
 *   k6 run --summary-export <out.json> stress/external/k6-mcp.js
 *
 * Percentiles p50/p95/p99 are emitted as trend metrics per operation
 * (op_initialize, op_tools_list, op_search, op_load, op_execute).
 */
import http from "k6/http";
import { check, fail, sleep } from "k6";
import { Trend } from "k6/metrics";
import { SharedArray } from "k6/data";

// Per-operation latency trends so the summary export carries p50/p95/p99 for
// each operation in the mix.
const T = {
  initialize: new Trend("op_initialize"),
  tools_list: new Trend("op_tools_list"),
  search: new Trend("op_search"),
  load: new Trend("op_load"),
  execute: new Trend("op_execute"),
};

const URL = (__ENV.K6_URL ?? "http://127.0.0.1:41711") + "/mcp";
const TOKEN = __ENV.K6_TOKEN ?? "";

// Seeded deterministic query/action pools (contract: no unseeded randomness).
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(42);

const QUERIES = new SharedArray("queries", function () {
  // Default pool is the one make-fixture.mjs generates from the actual
  // manifests — never a hard-coded action id.
  const path = __ENV.K6_QUERIES ?? "../.generated/external/queries.json";
  const parsed = JSON.parse(open(path));
  if (!Array.isArray(parsed) || parsed.length === 0) fail(`empty query pool: ${path}`);
  return parsed;
});
const ACTIONS = new SharedArray("actions", function () {
  const path = __ENV.K6_ACTIONS ?? "../.generated/external/actions.json";
  const parsed = JSON.parse(open(path));
  if (!Array.isArray(parsed) || parsed.length === 0) fail(`empty action pool: ${path}`);
  return parsed;
});

const params = {
  headers: {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${TOKEN}`,
  },
};

function rpc(method, rpcParams, op) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: Math.floor(rand() * 2 ** 31), method, params: rpcParams });
  const res = http.post(URL, body, Object.assign({}, params, { tags: { op } }));
  T[op]?.add(res.timings.duration);
  return res;
}

/**
 * A response is only a success when HTTP 200 AND the JSON-RPC envelope carries
 * no error (Action Hub returns application failures inside HTTP 200). The SDK
 * requires both Accept types but then answers SSE (`event: message` +
 * `data: {...}`), so parse that envelope too.
 */
function parseEnvelope(res) {
  try {
    return res.json();
  } catch {
    /* fall through to SSE */
  }
  const text = String(res.body ?? "");
  for (const line of text.split("\n")) {
    if (line.startsWith("data:")) {
      try {
        return JSON.parse(line.slice(5).trim());
      } catch {
        /* keep scanning */
      }
    }
  }
  return null;
}

function rpcOk(res) {
  if (res.status !== 200) return false;
  const body = parseEnvelope(res);
  if (!body) return false;
  if (body.error) return false;
  if (body.result?.isError === true) return false;
  return true;
}

function hubCall(payload, op) {
  return rpc("tools/call", { name: "action_hub", arguments: payload }, op);
}

const profile = __ENV.K6_PROFILE ?? "full";
export const options = Object.assign(
  {
    summaryTrendStats: ["avg", "min", "med", "max", "p(50)", "p(90)", "p(95)", "p(99)"],
    thresholds: {
      // Fail the run when JSON-RPC-level success rate drops below 99% or
      // request errors appear — not just on HTTP status.
      checks: [`rate>0.99`],
  // Recording thresholds — computed into the summary; loose enough not to
  // fail a run whose result we still want to report.
      "op_initialize": [`p(50)<2000`, `p(95)<5000`, `p(99)<10000`],
      "op_tools_list": [`p(50)<2000`, `p(95)<5000`, `p(99)<10000`],
      "op_search": [`p(50)<2000`, `p(95)<5000`, `p(99)<10000`],
      "op_load": [`p(50)<2000`, `p(95)<5000`, `p(99)<10000`],
      "op_execute": [`p(50)<2000`, `p(95)<5000`, `p(99)<10000`],
    },
  },
  profile === "quick"
    ? {
        scenarios: {
          quick: { executor: "constant-arrival-rate", rate: 5, timeUnit: "1s", duration: "15s", preAllocatedVUs: 5, maxVUs: 10 },
        },
      }
    : profile === "steps"
      ? {
          scenarios: {
            step50: { executor: "ramping-arrival-rate", startRate: 5, timeUnit: "1s", stages: [{ duration: "20s", target: 10 }, { duration: "20s", target: 10 }], preAllocatedVUs: 20, maxVUs: 60 },
            step100: { executor: "ramping-arrival-rate", startRate: 10, timeUnit: "1s", stages: [{ duration: "20s", target: 20 }, { duration: "20s", target: 20 }], preAllocatedVUs: 40, maxVUs: 120, startTime: "45s" },
            step200: { executor: "ramping-arrival-rate", startRate: 20, timeUnit: "1s", stages: [{ duration: "20s", target: 40 }, { duration: "20s", target: 40 }], preAllocatedVUs: 80, maxVUs: 240, startTime: "90s" },
          },
        }
      : {
        scenarios: {
          ramp: {
            executor: "ramping-vus",
            startVUs: 100,
            stages: [
              { duration: "30s", target: 100 },
              { duration: "30s", target: 200 },
              { duration: "30s", target: 300 },
              { duration: "30s", target: 400 },
              { duration: "30s", target: 500 },
              { duration: "60s", target: 500 },
              { duration: "30s", target: 0 },
            ],
            gracefulRampDown: "10s",
          },
          soak: {
            executor: "constant-vus",
            vus: 100,
            duration: "5m",
            startTime: "3m30s",
          },
        },
      }
);

export default function () {
  const r = rand();

  // Query/action pools are records `{query: "..."}` / action-id strings per the
  // contract; normalize defensively so a wrong shape fails loudly instead of
  // sending objects as query text.
  const rawQ = QUERIES[Math.floor(r * QUERIES.length)];
  const query = typeof rawQ === "string" ? rawQ : String(rawQ?.query ?? "");
  if (!query) fail("empty query in pool");
  const rawAction = ACTIONS[Math.floor(r * ACTIONS.length)];
  const actionId = typeof rawAction === "string" ? rawAction : String(rawAction?.action_id ?? rawAction?.id ?? "");
  if (!actionId) fail("empty action_id in pool");

  // 1. initialize
  const init = rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "k6", version: "0" } }, "initialize");
  check(init, { "initialize rpc-ok": () => rpcOk(init) });

  // 2. tools/list
  const list = rpc("tools/list", {}, "tools_list");
  check(list, { "tools/list rpc-ok": () => rpcOk(list) });

  // 3. action_hub search with a seeded random query
  const search = hubCall({ operation: "search", query, limit: 10 }, "search");
  check(search, { "search rpc-ok": () => rpcOk(search) });

  // 4. load one action id
  const load = hubCall({ operation: "load", action_id: actionId }, "load");
  check(load, { "load rpc-ok": () => rpcOk(load) });

  // 5. execute the same action (fixture tools are read-only, cheap)
  const exec = hubCall({ operation: "execute", action_id: actionId, arguments: { q: query } }, "execute");
  check(exec, { "execute rpc-ok": () => rpcOk(exec) });

  sleep(0.2);
}
