#!/usr/bin/env node
/**
 * stress/index-stall-bench.mjs — D1 perf gate (separate from the unit
 * suite; see packets D1/D1-R3..R6).
 *
 * Asserts that a cold cooperative semantic rebuild keeps event-loop stalls
 * bounded while indexing a 15k-record corpus:
 *   - time to first yield < 500ms  (pre-chunking measured ~666ms cold at 15k)
 *   - max event-loop stall < 500ms (measured 42.8ms in-process, 66.6ms
 *     independently by review at 15k; 500ms leaves >7x headroom while still
 *     failing the unchunked implementation, which stalls for the whole pass)
 *
 * Deliberately NOT part of `npm test`: absolute wall-clock bounds are
 * contention-sensitive (D1-R4), so this runs standalone under a quiet-ish
 * machine and fails loudly on regression.
 *
 * Output contract (stress CONTRACT): ONE finish path for success, no-yield/
 * bound failure, invalid args, and unexpected exceptions — writes
 * stress/.generated/results/index-stall-bench.json, prints exactly one
 * compact JSON summary as the last stdout line with ok:true/false, and
 * exits nonzero iff ok is false.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LocalSemanticIndex } from "../packages/core/dist/index.js";

const RESULTS_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  ".generated",
  "results",
  "index-stall-bench.json",
);

const WORDS = [
  "deploy", "pipeline", "rollback", "notify", "provision", "database", "shard",
  "backup", "monitor", "cache", "queue", "scheduler", "webhook",
];

class GateError extends Error {
  constructor(summary) { super(summary.error); this.summary = summary; }
}

function finish(summary) {
  try {
    fs.mkdirSync(path.dirname(RESULTS_PATH), { recursive: true });
    fs.writeFileSync(RESULTS_PATH, JSON.stringify(summary) + "\n");
  } catch (err) {
    summary.ok = false;
    summary.artifactError = String(err?.message ?? err);
  }
  console.log(JSON.stringify(summary));
  process.exitCode = summary.ok ? 0 : 1;
}

try {
  const N = Number(process.argv[2] ?? 15_000);
  const CHUNK = Number(process.argv[3] ?? 500);
  if (!Number.isInteger(N) || N < 1) {
    throw new GateError({
      ok: false, corpus: null, chunk: CHUNK,
      error: `corpus size N must be a positive integer, got "${process.argv[2] ?? N}"`,
    });
  }
  if (!Number.isInteger(CHUNK) || CHUNK < 1) {
    throw new GateError({
      ok: false, corpus: N, chunk: null,
      error: `chunk must be a positive integer, got "${process.argv[3] ?? CHUNK}"`,
    });
  }

  const records = Array.from({ length: N }, (_, i) => ({
    id: `bench:${i}`,
    kind: "tool",
    name: `tool_${i}`,
    serverId: "bench",
    summary: `capability ${i} ${WORDS[i % WORDS.length]} resource ${i}`,
    description: `capability ${i} ${WORDS[i % WORDS.length]} resource ${i} with ${WORDS[(i + 3) % WORDS.length]} and ${WORDS[(i + 7) % WORDS.length]} schedules for region ${i % 5}.`,
    tags: [],
    trust: "trusted",
  }));

  const t0 = performance.now();
  let firstYield = null;
  let yieldCount = 0;
  let lastYield = t0;
  let maxYieldGap = 0;
  let hbLast = t0;
  let hbMaxGap = 0;
  let hbTicks = 0;
  const heartbeat = setInterval(() => {
    hbTicks += 1;
    const now = performance.now();
    hbMaxGap = Math.max(hbMaxGap, now - hbLast);
    hbLast = now;
  }, 1);

  try {
    await new LocalSemanticIndex().indexCooperative(records, {
      chunkSize: CHUNK,
      yieldFn: () => {
        const now = performance.now();
        yieldCount += 1;
        if (firstYield === null) firstYield = now - t0;
        maxYieldGap = Math.max(maxYieldGap, now - lastYield);
        lastYield = now;
        return new Promise((done) => setImmediate(done));
      },
    });
  } finally {
    clearInterval(heartbeat);
  }

  // Account for the completion gap: the final chunk may run without a
  // trailing yield, so measure one last event-loop turn after indexing and
  // fold it into both gap histograms — an unchunked regression cannot hide
  // behind "the run finished".
  await new Promise((done) => setImmediate(done));
  const completion = performance.now();
  maxYieldGap = Math.max(maxYieldGap, completion - lastYield);
  hbMaxGap = Math.max(hbMaxGap, completion - hbLast);

  const result = {
    corpus: N,
    chunk: CHUNK,
    timeToFirstYieldMs: firstYield === null ? null : Number(firstYield.toFixed(1)),
    yieldCount,
    hbTicks,
    maxYieldGapMs: Number(maxYieldGap.toFixed(1)),
    maxHeartbeatGapMs: Number(hbMaxGap.toFixed(1)),
    totalMs: Number((lastYield - t0).toFixed(0)),
    bounds: { timeToFirstYieldMs: 500, maxStallMs: 500 },
  };
  // Hard evidence requirements — a fully synchronous (no-yield) rebuild
  // MUST fail here, not pass vacuously on empty gap histograms.
  result.ok =
    Number.isFinite(result.timeToFirstYieldMs) &&
    yieldCount >= 1 &&
    hbTicks >= 1 &&
    result.timeToFirstYieldMs <= result.bounds.timeToFirstYieldMs &&
    Math.max(result.maxYieldGapMs, result.maxHeartbeatGapMs) <= result.bounds.maxStallMs;
  if (!result.ok) {
    result.error = result.timeToFirstYieldMs === null
      ? "no yield observed — index preprocessing is not chunked"
      : "event-loop stall bound exceeded";
  }
  finish(result);
} catch (err) {
  if (err instanceof GateError) finish(err.summary);
  else finish({ ok: false, corpus: null, chunk: null, error: String(err?.message ?? err) });
}
