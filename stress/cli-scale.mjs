#!/usr/bin/env node
/**
 * stress/cli-scale.mjs — S8 "CLI and canvas at scale" (builder-3).
 *
 * Runs every Action Hub CLI command against a large, deterministic, fully
 * isolated setup and reports wall-time + output size for every step, with
 * machine-readable flags for anything slow (> 2 s) or producing outsized
 * output. (The capability-manager canvas phase was removed per PR 55 — the
 * canvas is being deleted; pre-deletion numbers live in the PR body only.)
 *
 * Contract (/tmp/action-hub-stress/CONTRACT.md) compliance:
 *   - never touches real user config: every CLI run executes under a
 *     generated HOME, XDG_CACHE_HOME, XDG_CONFIG_HOME, ACTION_HUB_CONFIG,
 *     ACTION_HUB_SKILLS_DIR and PI_CODING_AGENT_DIR; the fixture config sets
 *     autoDiscover:false
 *   - no network, no LLM calls; every fixture is generated from a seeded PRNG
 *   - generated data lives under stress/.generated/ (never committed)
 *   - plain Node ESM, node >= 20, no new dependencies
 *   - the LAST stdout line is a machine-readable JSON summary, also written
 *     to stress/.generated/results/cli-scale.json
 *
 * Fixtures use the contract formats. When the shared generators
 * (stress/gen-skills.mjs, stress/gen-tools.mjs, stress/fake-mcp-server.mjs,
 * stress/make-config.mjs) have produced stress/.generated fixtures, they are
 * consumed as-is; otherwise this script generates its own smaller fleet in
 * the same format so it can run standalone today.
 *
 * Usage: node stress/cli-scale.mjs [--scale small|full] [--seed 1337]
 * (seed 0 is valid; unknown --scale values fail loudly with a final summary)
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
// S8-R6 (PR 57 takeover): the hand-rolled spawn/isolation/teardown machinery is
// REPLACED by the shared stress/lib/harness.mjs primitives (PR 64/75):
// makeRunRoot (per-run unique root), buildIsolatedEnv/assertIsolated (one
// source of truth for the isolation checklist), runStep (anchored process
// groups; natural-exit AND timeout teardowns reap the WHOLE group incl. the
// CLI's own fake-server children — no worktree-wide pkill), and main() (the
// one finish path: artifact + one JSON last line + nonzero on ok:false).
import {
  assertIsolated,
  buildIsolatedEnv,
  FatalError,
  makeRunRoot,
  main as harnessMain,
  refusedInsideOwnerState,
  runStep as libRunStep,
} from "./lib/harness.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const CLI = join(REPO_ROOT, "packages", "cli", "dist", "index.js");
const GENERATED_DEFAULT = join(SCRIPT_DIR, ".generated");

const SHARED_FAKE_SERVER = join(SCRIPT_DIR, "fake-mcp-server.mjs");

const SLOW_MS = 2_000;              // flag any step slower than this
const LARGE_OUTPUT_BYTES = 5 << 20; // flag any stdout larger than 5 MB
const HUGE_CONFIG_BYTES = 10 << 20; // harness-install fixture configs target 10 MB

// ---------------------------------------------------------------------------
// CLI arguments
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name) => argv.includes("--" + name);
const opt = (name, fallback) => {
  const i = argv.indexOf("--" + name);
  return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};

// Fixture root: overridable so regressions can force the fixture-free
// fallback path regardless of ambient generated state.
const GENERATED = resolve(opt("generated", GENERATED_DEFAULT));
const SCALE = opt("scale", "small");
const SEED_ARG = opt("seed");
// Seed 0 is valid; only an unparseable value is rejected (checked in main so a
// final JSON summary is always emitted).
const SEED = SEED_ARG !== undefined ? Number.parseInt(SEED_ARG, 10) : 1337;

// ---------------------------------------------------------------------------
// Deterministic fixture generation
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let rng = mulberry32(SEED);
const pick = (arr) => arr[Math.floor(rng() * arr.length)];

const SCALES = {
  small: { servers: 8, toolsPerServer: 25, bigServers: 0, bigTools: 0, skills: 40, harnessServersPerConfig: 500 },
  // Exactly the contract fleet: 40 servers x 200 tools + 4 big servers x 500
  // tools = 44 manifests / 10,000 tools / 5,000 skills.
  full: { servers: 44, toolsPerServer: 200, bigServers: 4, bigTools: 500, skills: 5000, harnessServersPerConfig: 2000 },
};

/** Build tool manifests in the contract format; returns the server ids. */
function writeToolManifests(cfg, dir) {
  const toolsDir = join(dir, "tools");
  mkdirSync(toolsDir, { recursive: true });
  const serverIds = [];
  for (let s = 0; s < cfg.servers; s++) {
    const serverId = "acme-" + String(s).padStart(2, "0");
    serverIds.push(serverId);
    const isBig = s >= cfg.servers - cfg.bigServers;
    const count = isBig ? cfg.bigTools : cfg.toolsPerServer;
    const tools = [];
    for (let t = 0; t < count; t++) {
      const name = "action_" + serverId.replace(/-/g, "_") + "_" + String(t).padStart(4, "0");
      tools.push({
        name,
        description: pick(["List", "Fetch", "Create", "Update"]) + " " +
          pick(["CRM", "billing", "support", "analytics"]) + " " +
          pick(["records", "entries", "reports"]) + " (seeded fixture " + serverId + ":" + t + ").",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "record id" },
            query: { type: "string", description: "search text" },
            limit: { type: "number", description: "max rows" },
          },
          required: ["id"],
        },
        annotations: { readOnlyHint: t % 3 === 0 },
        behavior: { latencyMs: 0, errorRate: 0, responseBytes: 512 },
      });
    }
    writeFileSync(join(toolsDir, serverId + ".json"), JSON.stringify({ serverId, tools }));
  }
  return serverIds;
}

function buildConfigSkills(cfg) {
  const skills = [];
  for (let i = 0; i < cfg.skills; i++) {
    const slug = "stress-skill-" + String(i).padStart(5, "0");
    skills.push({
      id: "skill:" + slug,
      name: "Stress Skill " + String(i).padStart(5, "0"),
      summary: "Handles " + pick(["customer", "invoice", "deploy", "incident"]) +
        " " + pick(["questions", "runbooks", "lookups"]) + " (seeded fixture " + i + ").",
      description: "Use for " + pick(["onboarding", "escalations", "refunds", "reporting"]) +
        " questions. Confirm the context before acting. Prefer the read-only path unless a mutation is explicit. Summarize outcomes and follow-ups.",
      tags: ["stress"],
      trust: "trusted",
    });
  }
  return skills;
}

/** Parse SKILL.md frontmatter (name/description) into SkillConfig entries. */
function parseSkillFrontmatters(dir) {
  const skills = [];
  for (const slug of readdirSync(dir)) {
    const p = join(dir, slug, "SKILL.md");
    if (!existsSync(p)) continue;
    const md = readFileSync(p, "utf8");
    const fm = md.match(/^---\n([\s\S]*?)\n---/);
    if (!fm) continue;
    const name = (fm[1].match(/^name:\s*(.+)$/m) || [])[1] ?? slug;
    const description = (fm[1].match(/^description:\s*(.+)$/m) || [])[1] ?? "";
    const summary = (fm[1].match(/^summary:\s*(.+)$/m) || [])[1] ?? description;
    skills.push({ id: "skill:" + slug, name, summary, description, tags: ["stress"], trust: "trusted" });
  }
  return skills;
}

/** SKILL.md files in the contract format (frontmatter + exactly 4 sentences). */
function writeSkillFixtures(cfg, skillsDir) {
  const slugs = [];
  for (let i = 0; i < cfg.skills; i++) {
    const slug = "stress-skill-" + String(i).padStart(5, "0");
    const name = "Stress Skill " + String(i).padStart(5, "0");
    const description = "Handles " + pick(["customer", "invoice", "deploy", "incident"]) +
      " " + pick(["questions", "runbooks", "lookups"]) + " (seeded fixture " + i + ").";
    const body = [
      "Use this skill when the user asks about " + pick(["onboarding", "escalations", "refunds", "reporting"]) + " workflows.",
      "Start by confirming the " + pick(["account", "workspace", "project"]) + " context before acting.",
      "Prefer the " + pick(["audited", "read-only", "cached"]) + " path unless the user explicitly asks for a mutation.",
      "Always summarize the outcome and list any follow-up actions at the end.",
    ].join(" ");
    mkdirSync(join(skillsDir, slug), { recursive: true });
    writeFileSync(join(skillsDir, slug, "SKILL.md"), "---\nname: " + name + "\ndescription: " + description + "\n---\n" + body + "\n");
  }
  return null; // skill files feed ACTION_HUB_SKILLS_DIR consumers, not the CLI list
}

// ---------------------------------------------------------------------------
// Stand-in stdio MCP server (only used when stress/fake-mcp-server.mjs from
// builder-2 has not landed yet). Written to stress/.generated/ at runtime, so
// no second owner appears in stress/.
// ---------------------------------------------------------------------------

const FAKE_STDIO_SERVER = [
  "#!/usr/bin/env node",
  "// Minimal deterministic MCP stdio server (generated by stress/cli-scale.mjs).",
  "// Serves initialize + tools/list + tools/call from a contract-format manifest.",
  'import { readFileSync } from "node:fs";',
  'const i = process.argv.indexOf("--manifest");',
  'const manifest = JSON.parse(readFileSync(process.argv[i + 1], "utf8"));',
  'let buf = "";',
  'process.stdin.setEncoding("utf8");',
  'process.stdin.on("data", (chunk) => {',
  '  buf += chunk;',
  '  let nl;',
  '  while ((nl = buf.indexOf("\\n")) !== -1) {',
  '    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);',
  '    if (!line.trim()) continue;',
  '    let msg; try { msg = JSON.parse(line); } catch { continue; }',
  '    handle(msg);',
  '  }',
  '});',
  'process.stdin.on("end", () => process.exit(0));',
  'function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n"); }',
  'function handle(msg) {',
  '  if (!msg || msg.jsonrpc !== "2.0") return;',
  '  if (msg.method === "initialize") {',
  '    reply(msg.id, { protocolVersion: msg.params && msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: manifest.serverId, version: "0.0.1" } });',
  '  } else if (msg.method === "notifications/initialized") {',
  '    // notification: no response',
  '  } else if (msg.method === "tools/list") {',
  '    const tools = manifest.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations }));',
  '    reply(msg.id, { tools });',
  '  } else if (msg.method === "tools/call") {',
  '    reply(msg.id, { content: [{ type: "text", text: "ok" }] });',
  '  } else if (msg.id !== undefined) {',
  '    reply(msg.id, {});',
  '  }',
  '}',
].join("\n") + "\n";

// ---------------------------------------------------------------------------
// Isolation + CLI runner
// ---------------------------------------------------------------------------

let env = null; // assigned in runAll(); per-run isolation roots

// Every path-bearing isolation variable, per /tmp/action-hub-stress/ISOLATION.md.
// All resolve under the sandbox home, which itself lives under the run root.
const ISOLATION_PATH_VARS = [
  "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TMPDIR", "TMP", "TEMP",
  "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME",
  "ACTION_HUB_CONFIG", "ACTION_HUB_CACHE", "ACTION_HUB_SKILLS_DIR",
  "ACTION_HUB_DAEMON_DIR", "ACTION_HUB_CREDENTIALS", "ACTION_HUB_CONTROL",
  "CODEX_HOME", "CLAUDE_CONFIG_DIR", "PI_CODING_AGENT_DIR",
];

/**
 * ONE complete isolated environment for every child. Inherited values for the
 * checklist vars are always replaced (never forwarded), for every platform:
 * HOME and the Windows equivalents (USERPROFILE/APPDATA/LOCALAPPDATA) are all
 * pinned to the sandbox, so a Windows-style HOME-absent caller cannot leak the
 * real user profile into discovery or homedir().
 * baseEnv defaults to process.env but is injectable for the sentinel test.
 */
function isoEnv({ home, configPath } = {}, baseEnv = process.env) {
  if (!home) {
    if (!env) throw new Error("isoEnv called before run root assignment and without an explicit home");
    home = env.home;
  }
  // Delegate the checklist pinning to the shared lib (single source of truth);
  // only the harness-config override is cli-scale-specific.
  const childEnv = buildIsolatedEnv(home, baseEnv);
  if (configPath !== undefined) childEnv.ACTION_HUB_CONFIG = configPath;
  return childEnv;
}

/** Separator-safe containment: is `child` inside `parent`? (path.relative) */
function pathContains(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Sentinel: every path-bearing isolation var must resolve inside `home`. */
function assertIsoEnv(childEnv, home) {
  const violations = [];
  for (const name of ISOLATION_PATH_VARS) {
    const val = childEnv[name];
    if (val === undefined) { violations.push(name + " unset"); continue; }
    if (!pathContains(home, val)) {
      violations.push(name + "=" + val + " outside " + home);
    }
  }
  if (violations.length > 0) {
    throw new Error("isolation sentinel violated: " + violations.join("; "));
  }
}

/**
 * Owner-state guard (revised ISOLATION.md): refuse only when the run root
 * would sit inside the owner's REAL app-state or harness config locations —
 * never merely for being under home (os.tmpdir() is under USERPROFILE on
 * Windows). The real home comes from os.userInfo(), independently of $HOME.
 */
const OWNER_PROTECTED_DIRS = [
  ".cache/action-hub", ".config/action-hub", ".action-hub",
  "Library/Caches/action-hub", "Library/Application Support/action-hub",
  "AppData/Roaming/action-hub", "AppData/Local/action-hub",
  ".claude", ".claude.json", ".codex", ".cursor", ".copilot", ".pi", ".vscode",
];

function insideOwnerProtectedState(runRoot, realHome) {
  const absRoot = resolve(runRoot);
  const absHome = resolve(realHome);
  for (const rel of OWNER_PROTECTED_DIRS) {
    const protectedDir = join(absHome, rel);
    if (pathContains(protectedDir, absRoot)) return protectedDir;
  }
  return null;
}

const results = [];
const flags = [];
let fixtureSource = "self-generated"; // set in runAll()
let summaryFixtures = null; // observed fleet counts, set in runAll()
function flagSlow(step) {
  if (step.ms > SLOW_MS) flags.push({ kind: "slow", step: step.step, ms: step.ms });
  if ((step.stdoutBytes ?? 0) > LARGE_OUTPUT_BYTES) flags.push({ kind: "large-output", step: step.step, bytes: step.stdoutBytes });
}

// Bounded per-step timeout: no step may hang the run (MUST-FIX 3).
const STEP_TIMEOUT_MS = 300_000;

/**
 * Bounded, normalized child spawn. Spawn errors, signals and timeouts all
 * become failed steps (ok:false with an error field) instead of throwing or
 * hanging. Exported for the child-failure/timeout regressions.
 */
async function spawnStep(argv, { cwd, configPath, home, timeoutMs = STEP_TIMEOUT_MS } = {}) {
  const t0 = performance.now();
  // Direct invocations without a run root (tests) get a throwaway sandbox.
  const sandboxHome = home ?? (env ? env.home : mkdtempSync(join(tmpdir(), "cli-scale-step-")));
  const childEnv = isoEnv({ home: sandboxHome, configPath });
  // Sentinel on the FINAL env of EVERY spawn, after configPath overrides:
  // every path-bearing var must resolve inside the run root. An unrooted
  // configPath (the import-target bug class) fails the run here.
  if (env) assertIsolated(childEnv, env.runRoot);
  // lib runStep: anchored process group + bounded timeout + group-scoped
  // teardown on natural exit AND timeout (no worktree-wide pkill needed).
  const r = await libRunStep(argv[0], argv.slice(1), { env: childEnv, cwd: cwd ?? sandboxHome, timeoutMs });
  const step = { argv: argv.join(" "), ms: Math.round(performance.now() - t0) };
  if (r.error) {
    step.ok = false;
    step.error = r.error;
    step.timedOut = !!r.timedOut;
  } else if (r.signal) {
    step.ok = false;
    step.error = "killed by signal " + r.signal + (r.signal === "SIGTERM" ? " (likely step timeout)" : "");
  } else {
    step.exit = r.code;
    step.ok = r.code === 0;
    step.stdout = r.stdout ?? "";
    step.stderr = r.stderr ?? "";
    step.stdoutBytes = Buffer.byteLength(step.stdout);
    step.stderrBytes = Buffer.byteLength(step.stderr);
  }
  return step;
}

async function runCli(stepName, args, { configPath, cwd } = {}) {
  const step = await spawnStep([process.execPath, CLI, ...args], { configPath, cwd });
  step.step = stepName;
  step.argv = "action-hub " + args.join(" ");
  if (step.stdout && env) writeFileSync(join(env.runRoot, "logs", step.step.replace(/[\/ ]+/g, "_") + "-" + results.length + ".out"), step.stdout);
  if (step.stderr && env) writeFileSync(join(env.runRoot, "logs", step.step.replace(/[\/ ]+/g, "_") + "-" + results.length + ".err"), step.stderr);
  results.push(step);
  flagSlow(step);
  return step;
}

function loadQueries(name, { fallback = [], required = false } = {}) {
  const p = join(GENERATED, name);
  if (!existsSync(p)) {
    if (required) throw new Error("required query artifact missing: " + name);
    return fallback;
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(p, "utf8"));
  } catch (err) {
    // Malformed generated JSON is a fixture defect: fail loudly rather than
    // silently swapping in fallback queries and mislabeling the evidence.
    throw new Error("malformed query artifact " + name + ": " + err.message);
  }
  const qs = raw.queries ?? (Array.isArray(raw) ? raw : null);
  if (!Array.isArray(qs)) throw new Error("query artifact " + name + " has no queries array");
  return qs;
}

// ---------------------------------------------------------------------------
// Phase: CLI commands against the curated fixture config
// ---------------------------------------------------------------------------

async function phaseCliBenchmarks({ configPath, serverIds }) {
  // cwd = REPO_ROOT: shared manifests carry relative manifest paths, so fake
  // servers spawned by the hub resolve them against the repo root.
  const opts = { configPath, cwd: REPO_ROOT };

  await runCli("cli.list-all", ["list", "--kind", "all"], opts);
  for (const serverId of serverIds) {
    await runCli("cli.list-server", ["list", "--server", serverId], opts);
  }
  await runCli("cli.list-tools", ["list", "--kind", "tool"], opts);
  await runCli("cli.list-skills", ["list", "--kind", "skill"], opts);

  // Sample the shared query corpora (1000 tool queries / 500 skill queries —
  // running all would dominate wall time; sample evenly across subtypes).
  const sample = (qs, n) => {
    if (!qs || qs.length === 0) return [];
    const stepSize = Math.max(1, Math.floor(qs.length / n));
    return qs.filter((_, i) => i % stepSize === 0).slice(0, n);
  };
  const toolQueries = loadQueries("tools-queries.json", { fallback: ["list crm contacts", "invoices export", "pipelines reports"], required: fixtureSource === "shared" });
  const skillQueries = loadQueries("skills-queries.json", { fallback: [], required: fixtureSource === "shared" });
  for (const q of sample(toolQueries.map((x) => (typeof x === "string" ? x : x.query)), 10)) {
    await runCli("cli.test-search", ["test-search", q], opts);
  }
  for (const q of sample(skillQueries.map((x) => (typeof x === "string" ? x : x.query)), 5)) {
    await runCli("cli.test-search", ["test-search", q], opts);
  }

  await runCli("cli.bundle-list", ["bundle"], opts);
  const cfgBundles = JSON.parse(readFileSync(configPath, "utf8")).bundles ?? [];
  if (cfgBundles.length > 0) {
    await runCli("cli.bundle-export", ["bundle", "--export", cfgBundles[0].id], opts);
  } else {
    recordStepNote("cli.bundle-export", "skipped: fixture config declares no bundles");
  }
  await runCli("cli.doctor", ["doctor", "--no-check"], opts);
}

// ---------------------------------------------------------------------------
// Phase: import + migrate against a fake HOME full of harness configs
// ---------------------------------------------------------------------------

const HARNESS_LOCATIONS = [
  { client: "claude-desktop", rel: "Library/Application Support/Claude/claude_desktop_config.json" },
  { client: "cursor", rel: ".cursor/mcp.json" },
  { client: "vscode", rel: ".vscode/mcp.json" },
  { client: "copilot", rel: ".copilot/mcp.json" },
  { client: "codex", rel: ".codex/config.toml" },
  { client: "windsurf", rel: ".codeium/windsurf/mcp_config.json" },
  { client: "roo-code", rel: ".roo/mcp.json" },
  { client: "cline", rel: "Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json" },
  { client: "roo-code", rel: "Library/Application Support/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json" },
];

function harnessServerJson(id) {
  return {
    command: "/bin/echo",
    args: [id],
    env: { TOKEN: "seeded-token-" + id },
  };
}

/** Fill a fake HOME with harness configs; returns number of servers planted. */
function plantHarnessConfigs(home, perConfig) {
  let planted = 0;
  let file = 0;
  for (const loc of HARNESS_LOCATIONS) {
    const path = join(home, loc.rel);
    mkdirSync(dirname(path), { recursive: true });
    const servers = {};
    for (let i = 0; i < perConfig; i++) {
      const id = loc.client + "-f" + file + "-s" + String(i).padStart(4, "0");
      servers[id] = harnessServerJson(id);
    }
    planted += perConfig;
    file++;
    if (loc.client === "codex") {
      writeFileSync(path, buildCodexToml(servers));
    } else {
      writeFileSync(path, JSON.stringify({ mcpServers: servers }));
    }
  }
  return planted;
}

function buildCodexToml(servers) {
  // Codex config.toml: [mcp_servers.<id>] tables with command/args.
  let out = "";
  for (const [id, cfg] of Object.entries(servers)) {
    out += "\n[mcp_servers." + id + "]\n";
    out += 'command = "' + cfg.command + '"\n';
    out += "args = [" + cfg.args.map((a) => '"' + a + '"').join(", ") + "]\n";
  }
  return out;
}

async function phaseImportMigrate({ perConfig }) {
  // Fresh empty target config for --write; discovery input comes from the
  // isolated fake HOME, not from the curated fixture config.
  // Live configs (including migration targets) must live inside the run root.
  const importConfigPath = join(env.runRoot, "import-target-servers.json");
  writeFileSync(importConfigPath, JSON.stringify({ autoDiscover: false, servers: [] }));

  const planted = plantHarnessConfigs(env.home, perConfig);
  recordStepNote("fake-home", "planted " + planted + " servers across " + HARNESS_LOCATIONS.length + " harness configs under isolated HOME");

  await runCli("cli.import-dry", ["import"], { configPath: importConfigPath });
  await runCli("cli.import-write", ["import", "--write"], { configPath: importConfigPath });
  await runCli("cli.migrate-plan", ["migrate", "--json"], { configPath: importConfigPath });
  await runCli("cli.migrate-write", ["migrate", "--write"], { configPath: importConfigPath });
}

function recordStepNote(step, note) {
  results.push({ step, note });
}

// ---------------------------------------------------------------------------
// Phase: harness install against huge existing configs
// ---------------------------------------------------------------------------

function padJsonServers(path, count, targetBytes) {
  const mk = (i) => ({ command: "/bin/echo", args: ["pad-" + i], env: { PADDING: "x".repeat(64) } });
  const servers = {};
  for (let i = 0; i < count; i++) servers["existing-" + String(i).padStart(4, "0")] = mk(i);
  let json = JSON.stringify({ mcpServers: servers }, null, 2);
  // Pad every server's harmless PADDING env value until >= targetBytes (one pass).
  const deficit = targetBytes - Buffer.byteLength(json);
  if (deficit > 0) {
    const extra = Math.ceil(deficit / count);
    for (const s of Object.values(servers)) s.env.PADDING += "x".repeat(extra);
    json = JSON.stringify({ mcpServers: servers }, null, 2);
  }
  writeFileSync(path, json);
  return Buffer.byteLength(json);
}

function padTomlServers(path, count, targetBytes) {
  let out = "";
  for (let i = 0; i < count; i++) {
    const id = "existing-" + String(i).padStart(4, "0");
    out += "\n[mcp_servers." + id + "]\n";
    out += 'command = "/bin/echo"\n';
    out += 'args = ["' + id + '"]\n';
    out += 'env = { PADDING = "' + "x".repeat(256) + '" }\n';
  }
  // Linear padding: track byte growth incrementally with bounded chunks
  // (the previous whole-string Buffer.byteLength per iteration was quadratic
  // and CPU-bound the parent for minutes at 10 MB).
  let len = Buffer.byteLength(out);
  if (len < targetBytes) {
    const filler = "x".repeat(1024);
    let i = 0;
    while (len < targetBytes) {
      const chunk = '\n[mcp_servers.padding.' + String(i).padStart(6, "0") + ']\n' +
        'command = "/bin/echo"\n' +
        'args = ["' + filler + '"]\n';
      out += chunk;
      len += Buffer.byteLength(chunk);
      i++;
    }
  }
  writeFileSync(path, out);
  return len;
}

async function phaseHarnessInstall() {
  // Distinct fake HOME per install target so nothing else interferes.
  const cursorHome = join(env.runRoot, "harness-cursor");
  const codexHome = join(env.runRoot, "harness-codex");
  mkdirSync(join(cursorHome, ".cursor"), { recursive: true });
  mkdirSync(join(codexHome, ".codex"), { recursive: true });

  const mcpJsonPath = join(cursorHome, ".cursor", "mcp.json");
  const tomlPath = join(codexHome, ".codex", "config.toml");
  const jsonBytes = padJsonServers(mcpJsonPath, 2_000, HUGE_CONFIG_BYTES);
  const tomlBytes = padTomlServers(tomlPath, 2_000, HUGE_CONFIG_BYTES);
  recordStepNote("harness-install", "planted mcp.json=" + jsonBytes + "B config.toml=" + tomlBytes + "B");

  // harness cursor install --write (HOME=cursorHome)
  const t0 = performance.now();
  const step1 = await spawnStep([process.execPath, CLI, "harness", "cursor", "install", "--write"], {
    cwd: cursorHome,
    home: cursorHome,
    configPath: join(env.home, "servers.json"),
  });
  step1.step = "cli.harness-cursor-install";
  step1.argv = "action-hub harness cursor install --write (10MB mcp.json)";
  results.push(step1); flagSlow(step1);

  // Verify: .bak created, JSON still parses, action-hub entry present, originals intact.
  // .bak files are timestamped: <file>.bak-<stamp>
  const baks = readdirSync(dirname(mcpJsonPath)).filter((f) => f.startsWith("mcp.json.bak-"));
  const after = JSON.parse(readFileSync(mcpJsonPath, "utf8"));
  const bakOk = baks.length > 0 && Object.keys(JSON.parse(readFileSync(join(dirname(mcpJsonPath), baks[0]), "utf8")).mcpServers).length === 2_000;
  step1.verify = {
    bakCreated: baks.length > 0,
    bakOriginalCountIntact: !!bakOk,
    merged: Object.keys(after.mcpServers).some((k) => k === "action-hub"),
    totalCount: Object.keys(after.mcpServers).length,
  };
  if (!step1.verify.merged || !bakOk) step1.ok = false;

  const step2 = await spawnStep([process.execPath, CLI, "harness", "codex", "install", "--write"], {
    cwd: codexHome,
    home: codexHome,
    configPath: join(env.home, "servers.json"),
  });
  step2.step = "cli.harness-codex-install";
  step2.argv = "action-hub harness codex install --write (10MB config.toml)";
  results.push(step2); flagSlow(step2);

  const tomlAfter = readFileSync(tomlPath, "utf8");
  const tomlBaks = readdirSync(dirname(tomlPath)).filter((f) => f.startsWith("config.toml.bak-"));
  step2.verify = {
    bakCreated: tomlBaks.length > 0,
    merged: tomlAfter.includes("action-hub"),
    tomlBytesAfter: Buffer.byteLength(tomlAfter),
  };
  if (!step2.verify.merged || !step2.verify.bakCreated) step2.ok = false;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function emitSummary(totalMs, error = null) {
  const steps = results.map(({ stdout, stderr, ...rest }) => rest);
  const stepOk = steps.every((s) => s.ok === undefined || s.ok === true);
  // The results artifact is owned by harness main() (guarded write + stale
  // removal); emitSummary only BUILDS and PRINTS the summary.
  const summary = {
    scale: SCALE,
    seed: SEED,
    thresholds: { slowMs: SLOW_MS, largeOutputBytes: LARGE_OUTPUT_BYTES },
    fixtures: summaryFixtures,
    totalMs,
    steps,
    flags,
    ...(error ? { error } : {}),
    // A run with failed measured commands or a setup/verification exception
    // is NOT ok; main() exits nonzero on it.
    ok: stepOk && error === null,
  };
  console.log("\n--- per-step measurements ---");
  for (const s of steps) {
    if (s.note !== undefined) { console.log("[note] " + s.step + ": " + s.note); continue; }
    if (s.verify) console.log("[verify] " + s.step + ": " + JSON.stringify(s.verify));
    console.log(
      (s.ok === false ? "FAIL " : "ok   ") + s.step.padEnd(24) +
      " ms=" + String(s.ms ?? "-").padStart(7) +
      " out=" + String(s.stdoutBytes ?? "-").padStart(9) +
      " err=" + String(s.stderrBytes ?? "-").padStart(7)
    );
  }
  console.log("\n--- flags (slow > " + SLOW_MS + "ms, output > " + LARGE_OUTPUT_BYTES + "B) ---");
  console.log(flags.length === 0 ? "(none)" : JSON.stringify(flags, null, 2));
  console.log(JSON.stringify(summary));
  return summary;
}

// Exposed for stress/cli-scale.test.mjs (determinism + fake-server handshake).
export const __test = {
  writeToolManifests, buildConfigSkills, writeSkillFixtures, FAKE_STDIO_SERVER, SCALES,
  isoEnv, assertIsoEnv, ISOLATION_PATH_VARS, spawnStep, padTomlServers, padJsonServers,
  pathContains, insideOwnerProtectedState,
  observeFleet, validateFleet, expectedFleet,
  reseed: (seed) => { rng = mulberry32(seed); },
};

// S8-R6: ONE finish path via stress/lib/harness.mjs main() — stale-result
// removal, guarded artifact write (stress/.generated/results/cli-scale.json),
// exactly one compact JSON summary as the last stdout line, nonzero exit on
// ok:false, and the interrupt sweep for SIGTERM mid-run. Every failure
// (bad --scale, bad --seed, setup error, refused --generated path) flows
// through it; nothing runs at import time (the test imports this module).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await harnessMain(async () => {
    const t0 = performance.now();
    if (SCALE !== "small" && SCALE !== "full") {
      throw new FatalError("Unknown --scale value: " + SCALE + " (expected small|full)");
    }
    if (!Number.isFinite(SEED)) {
      throw new FatalError("Invalid --seed value: " + SEED_ARG);
    }
    console.log("action-hub cli-scale stress — scale=" + SCALE + " seed=" + SEED);
    await runAll();
    return emitSummary(Math.round(performance.now() - t0), null);
  }, { resultsPath: join(GENERATED, "results", "cli-scale.json") });
}

// ---------------------------------------------------------------------------
// Fleet observation + validation (MUST-FIX 2)
// ---------------------------------------------------------------------------

/** Read the config and count the ACTUAL server/tool/skill corpus. */
function observeFleet(configPath) {
  const cfg = JSON.parse(readFileSync(configPath, "utf8"));
  if (!Array.isArray(cfg.servers) || cfg.servers.length === 0) {
    throw new Error("fixture config has no servers");
  }
  let tools = 0;
  for (const srv of cfg.servers) {
    const args = (srv.transport && srv.transport.args) || [];
    const i = args.indexOf("--manifest");
    if (i === -1 || !args[i + 1]) {
      throw new Error("server " + srv.id + " has no --manifest arg in its transport");
    }
    const manifestPath = resolve(REPO_ROOT, args[i + 1]);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (!Array.isArray(manifest.tools) || manifest.tools.length === 0) {
      throw new Error("manifest for server " + srv.id + " (" + manifestPath + ") has no tools");
    }
    tools += manifest.tools.length;
  }
  const skills = Array.isArray(cfg.skills) ? cfg.skills.length : 0;
  return { servers: cfg.servers.length, tools, skills };
}

/** Fail loudly unless the observed corpus is exactly the expected fleet. */
function validateFleet(observed, expected) {
  for (const k of ["servers", "tools", "skills"]) {
    if (observed[k] !== expected[k]) {
      throw new Error("fixture fleet mismatch: observed " + k + "=" + observed[k] + ", expected " + expected[k]);
    }
  }
}

function expectedFleet() {
  // Shared corpus IS the contract fleet regardless of --scale (there is no
  // small shared corpus); only the self-generated fallback differs.
  if (fixtureSource === "shared" || SCALE === "full") {
    return { servers: 44, tools: 10_000, skills: 5_000 };
  }
  return { servers: 8, tools: 200, skills: 40 }; // small fallback fleet
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function buildBundles(serverIds) {
  // Reference real tool ids from the first manifest so bundle export works.
  const manifest = JSON.parse(readFileSync(join(GENERATED, "tools", serverIds[0] + ".json"), "utf8"));
  return [0, 1, 2, 3, 4].map((b) => ({
    id: "triage-" + b,
    displayName: "Stress Bundle " + b,
    description: "Bundled stress toolset " + b + ".",
    actionIds: manifest.tools.slice(b, b + 5).map((t) => serverIds[0] + ":" + t.name),
  }));
}

async function runAll() {
  const cfg = SCALES[SCALE];

  // Owner-state guard for the FIXTURE/artifact dir (revised ISOLATION.md, and
  // the cheap non-blocking item from S8-R5): refuse before any work when the
  // overridable --generated path sits inside the owner's real app-state.
  const generatedConflict = refusedInsideOwnerState(GENERATED);
  if (generatedConflict) {
    throw new FatalError("refusing to run: --generated " + GENERATED + " is inside owner state dir " + generatedConflict);
  }

  // Per-run UNIQUE root under the real tmpdir (S8-R5 blocker 2): two runs from
  // the same checkout must never share — or delete each other's — state.
  const runRoot = makeRunRoot("cli-scale-");
  const home = join(runRoot, "home");
  const skillsDir = join(home, "skills"); // fallback skill fixtures; corpus travels via config.skills
  for (const d of [home, join(home, ".cache"), join(home, ".config"), skillsDir, join(runRoot, "logs")]) {
    mkdirSync(d, { recursive: true });
  }
  env = { runRoot, home };

  // Sentinel: the env every child will get must be fully sandboxed (lib
  // assertIsolated is the single source of truth for the checklist).
  assertIsolated(isoEnv({ home }), runRoot);

  // Fixtures: prefer the shared generators' corpus in stress/.generated
  // (tools/*.json + skills/ + servers.json from make-config.mjs); fall back to
  // self-generated small fixtures in the same contract format. Shared fixtures
  // are validated (every manifest parses and has tools; query artifacts exist);
  // a partial or stale corpus fails loudly instead of producing mislabeled
  // evidence.
  const sharedToolsDir = join(GENERATED, "tools");
  const sharedServersJson = join(GENERATED, "servers.json");
  const sharedSkills = join(GENERATED, "skills");
  let serverIds, configSkills, configPath;
  const sharedCandidates = existsSync(sharedServersJson) && existsSync(sharedToolsDir) &&
    readdirSync(sharedToolsDir).some((f) => f.endsWith(".json") && f !== "tools-queries.json");
  if (sharedCandidates) {
    fixtureSource = "shared";
    console.log("using shared fixtures from stress/.generated (tools + skills + servers.json)");
    const base = JSON.parse(readFileSync(sharedServersJson, "utf8"));
    if (!Array.isArray(base.servers) || base.servers.length === 0) {
      throw new Error("shared servers.json has no servers array");
    }
    // Validate every configured server's manifest (parses, has tools).
    for (const srv of base.servers) {
      const args = (srv.transport && srv.transport.args) || [];
      const i = args.indexOf("--manifest");
      if (i === -1) throw new Error("shared config server " + srv.id + " has no --manifest arg");
      const manifest = JSON.parse(readFileSync(resolve(REPO_ROOT, args[i + 1]), "utf8"));
      if (!Array.isArray(manifest.tools) || manifest.tools.length === 0) {
        throw new Error("shared manifest for " + srv.id + " has no tools");
      }
    }
    // Skills tree + query artifacts are required in shared mode.
    if (!existsSync(sharedSkills) || readdirSync(sharedSkills).filter((d) => existsSync(join(sharedSkills, d, "SKILL.md"))).length === 0) {
      throw new Error("shared skills tree missing or empty at " + sharedSkills);
    }
    loadQueries("tools-queries.json", { required: true });
    loadQueries("skills-queries.json", { required: true });

    serverIds = base.servers.map((srv) => srv.id);
    // Merge the skills corpus into the config so `list --kind skill` and
    // test-search exercise them (make-config emits servers only).
    configSkills = parseSkillFrontmatters(sharedSkills);
    configPath = join(runRoot, "servers-with-skills.json");
    writeFileSync(configPath, JSON.stringify({ autoDiscover: false, servers: base.servers, bundles: base.bundles ?? [], skills: configSkills }, null, 2));
  } else {
    serverIds = writeToolManifests(cfg, GENERATED);
    writeSkillFixtures(cfg, skillsDir);
    configSkills = buildConfigSkills(cfg);

    // Stdio fake server: prefer builder-2's shared one, else write our own.
    let fakeServerPath = SHARED_FAKE_SERVER;
    if (!existsSync(fakeServerPath)) {
      fakeServerPath = join(runRoot, "fake-stdio-server.mjs");
      writeFileSync(fakeServerPath, FAKE_STDIO_SERVER);
    }
    configPath = join(runRoot, "servers.json");
    writeFileSync(configPath, JSON.stringify({
      autoDiscover: false,
      servers: serverIds.map((id) => ({
        id,
        displayName: "Acme " + id,
        trust: "trusted",
        enabled: true,
        transport: { type: "stdio", command: process.execPath, args: [fakeServerPath, "--manifest", join(GENERATED, "tools", id + ".json")] },
      })),
      skills: configSkills,
      bundles: buildBundles(serverIds),
    }, null, 2));
  }

  // Derive ACTUAL counts from the selected fixtures and fail loudly on any
  // mismatch with the expected fleet (full = exactly 44/10,000/5,000).
  const observed = observeFleet(configPath);
  const expected = expectedFleet();
  validateFleet(observed, expected);
  summaryFixtures = { source: fixtureSource, ...observed };
  console.log("fixtures (" + fixtureSource + "): " + observed.servers + " servers, " +
    observed.tools + " tools, " + observed.skills + " skills, " +
    cfg.harnessServersPerConfig + " servers per harness config for import/migrate");

  try {
    phaseCliBenchmarks({ configPath, serverIds });
    phaseImportMigrate({ perConfig: cfg.harnessServersPerConfig });
    phaseHarnessInstall();
  } finally {
    // S8-R6: NO worktree-wide pkill. Every CLI step runs in an anchored
    // process group via lib runStep, which reaps the WHOLE group (including
    // the CLI's fake-server children) on natural exit AND timeout, and
    // lib main()'s interrupt sweep handles SIGTERM mid-run. Recorded PIDs
    // only — nothing path-globbed, nothing shared with other checkouts.
    if (results.length > 0) {
      console.log("group teardown: " + results.length + " steps reaped by lib runStep (anchored groups)");
    }
  }
}
