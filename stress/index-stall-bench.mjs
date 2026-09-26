#!/usr/bin/env node
/**
 * stress/index-stall-bench.mjs — D1/R3 perf gate (separate from the unit
 * suite; see packets D1/D1-R3/D1-R4).
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
 */
import { LocalSemanticIndex } from "../packages/core/dist/index.js";

const N = Number(process.argv[2] ?? 15_000);
const CHUNK = Number(process.argv[3] ?? 500);
if (!Number.isInteger(N) || N < 1) {
  console.error(`FAIL: corpus size N must be a positive integer, got "${process.argv[2] ?? N}"`);
  process.exit(1);
}
if (!Number.isInteger(CHUNK) || CHUNK < 1) {
  console.error(`FAIL: chunk must be a positive integer, got "${process.argv[3] ?? CHUNK}"`);
  process.exit(1);
}
const WORDS = [
  "deploy", "pipeline", "rollback", "notify", "provision", "database", "shard",
  "backup", "monitor", "cache", "queue", "scheduler", "webhook",
];
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
clearInterval(heartbeat);

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
console.log(JSON.stringify(result));
// Hard evidence requirements — a fully synchronous (no-yield) rebuild MUST
// fail here, not pass vacuously on empty gap histograms.
const fail =
  result.timeToFirstYieldMs === null ||
  !Number.isFinite(result.timeToFirstYieldMs) ||
  yieldCount < 1 ||
  hbTicks < 1 ||
  result.timeToFirstYieldMs > result.bounds.timeToFirstYieldMs ||
  Math.max(result.maxYieldGapMs, result.maxHeartbeatGapMs) > result.bounds.maxStallMs;
if (fail) {
  console.error("FAIL: event-loop stall bound exceeded — index preprocessing is not chunked");
  process.exit(1);
}
