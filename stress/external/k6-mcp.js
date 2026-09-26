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
import { check, sleep } from "k6";
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
  const fallback = ["show me recent crm records", "find billing invoices", "search inventory items"];
  try {
    if (__ENV.K6_QUERIES) return JSON.parse(open(__ENV.K6_QUERIES));
  } catch {
    /* fall back */
  }
  return fallback;
});
const ACTIONS = new SharedArray("actions", function () {
  const fallback = ["fixture-00:list_crm_000"];
  try {
    if (__ENV.K6_ACTIONS) return JSON.parse(open(__ENV.K6_ACTIONS));
  } catch {
    /* fall back */
  }
  return fallback;
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

function hubCall(payload, op) {
  return rpc("tools/call", { name: "action_hub", arguments: payload }, op);
}

const profile = __ENV.K6_PROFILE ?? "full";
export const options = Object.assign(
  {
    summaryTrendStats: ["avg", "min", "med", "max", "p(50)", "p(90)", "p(95)", "p(99)"],
    thresholds: {
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
          quick: { executor: "constant-arrival-rate", rate: 20, timeUnit: "1s", duration: "15s", preAllocatedVUs: 20, maxVUs: 50 },
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

  // 1. initialize
  const init = rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "k6", version: "0" } }, "initialize");
  check(init, { "initialize 200": (res) => res.status === 200 });

  // 2. tools/list
  const list = rpc("tools/list", {}, "tools_list");
  check(list, { "tools/list 200": (res) => res.status === 200 });

  // 3. action_hub search with a seeded random query
  const q = QUERIES[Math.floor(r * QUERIES.length)];
  const search = hubCall({ operation: "search", query: q, limit: 10 }, "search");
  check(search, { "search 200": (res) => res.status === 200 });

  // 4. load one action id
  const actionId = ACTIONS[Math.floor(r * ACTIONS.length)];
  const load = hubCall({ operation: "load", action_id: actionId }, "load");
  check(load, { "load 200": (res) => res.status === 200 });

  // 5. execute the same action (fixture tools are read-only, cheap)
  const exec = hubCall({ operation: "execute", action_id: actionId, arguments: { q } }, "execute");
  check(exec, { "execute 200": (res) => res.status === 200 });

  sleep(0.2);
}
