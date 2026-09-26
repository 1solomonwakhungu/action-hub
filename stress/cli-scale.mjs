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
 * Usage: node stress/cli-scale.mjs [--scale small|full] [--seed 1337] [--keep]
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const CLI = join(REPO_ROOT, "packages", "cli", "dist", "index.js");
const GENERATED = join(SCRIPT_DIR, ".generated");
const RESULTS_DIR = join(GENERATED, "results");
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

const SCALE = opt("scale", "small") === "full" ? "full" : "small";
const SEED = Number.parseInt(opt("seed", "1337"), 10) || 1337;

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
  full: { servers: 40, toolsPerServer: 200, bigServers: 4, bigTools: 500, skills: 5000, harnessServersPerConfig: 2000 },
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

async function main() {
  console.log("action-hub cli-scale stress — scale=" + SCALE + " seed=" + SEED);
  const t0 = performance.now();
  await runAll();
  emitSummary(Math.round(performance.now() - t0));
}

// ---------------------------------------------------------------------------
// Isolation + CLI runner
// ---------------------------------------------------------------------------

let env = null; // assigned in runAll(); per-run isolation roots

function isoEnv(configPath) {
  return {
    ...process.env,
    HOME: env.home,
    XDG_CACHE_HOME: env.xdgCache,
    XDG_CONFIG_HOME: env.xdgConfig,
    ACTION_HUB_CONFIG: configPath,
    ACTION_HUB_SKILLS_DIR: env.skillsDir,
    PI_CODING_AGENT_DIR: join(env.home, "pi-agent"),
  };
}

const results = [];
const flags = [];
function flagSlow(step) {
  if (step.ms > SLOW_MS) flags.push({ kind: "slow", step: step.step, ms: step.ms });
  if ((step.stdoutBytes ?? 0) > LARGE_OUTPUT_BYTES) flags.push({ kind: "large-output", step: step.step, bytes: step.stdoutBytes });
}

function runCli(stepName, args, { configPath, cwd } = {}) {
  const t0 = performance.now();
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    cwd: cwd ?? env.home,
    env: isoEnv(configPath),
    maxBuffer: 256 * 1024 * 1024,
  });
  const step = {
    step: stepName,
    argv: "action-hub " + args.join(" "),
    ms: Math.round(performance.now() - t0),
    exit: res.status,
    stdoutBytes: res.stdout ? Buffer.byteLength(res.stdout) : 0,
    stderrBytes: res.stderr ? Buffer.byteLength(res.stderr) : 0,
    ok: res.status === 0,
    stdout: res.stdout,
    stderr: res.stderr,
  };
  if (res.stdout) writeFileSync(join(env.runRoot, "logs", step.step.replace(/[\/ ]+/g, "_") + "-" + results.length + ".out"), res.stdout);
  if (res.stderr) writeFileSync(join(env.runRoot, "logs", step.step.replace(/[\/ ]+/g, "_") + "-" + results.length + ".err"), res.stderr);
  results.push(step);
  flagSlow(step);
  return step;
}

function loadQueries(name, fallback) {
  const p = join(GENERATED, name);
  if (existsSync(p)) {
    try {
      const raw = JSON.parse(readFileSync(p, "utf8"));
      return raw.queries ?? (Array.isArray(raw) ? raw : fallback);
    } catch { return fallback; }
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Phase: CLI commands against the curated fixture config
// ---------------------------------------------------------------------------

function phaseCliBenchmarks({ configPath, serverIds }) {
  // cwd = REPO_ROOT: shared manifests carry relative manifest paths, so fake
  // servers spawned by the hub resolve them against the repo root.
  const opts = { configPath, cwd: REPO_ROOT };

  runCli("cli.list-all", ["list", "--kind", "all"], opts);
  for (const serverId of serverIds) {
    runCli("cli.list-server", ["list", "--server", serverId], opts);
  }
  runCli("cli.list-tools", ["list", "--kind", "tool"], opts);
  runCli("cli.list-skills", ["list", "--kind", "skill"], opts);

  // Sample the shared query corpora (1000 tool queries / 500 skill queries —
  // running all would dominate wall time; sample evenly across subtypes).
  const sample = (qs, n) => {
    if (!qs || qs.length === 0) return [];
    const stepSize = Math.max(1, Math.floor(qs.length / n));
    return qs.filter((_, i) => i % stepSize === 0).slice(0, n);
  };
  const toolQueries = loadQueries("tools-queries.json", ["list crm contacts", "invoices export", "pipelines reports"]);
  const skillQueries = loadQueries("skills-queries.json", []);
  for (const q of sample(toolQueries.map((x) => (typeof x === "string" ? x : x.query)), 10)) {
    runCli("cli.test-search", ["test-search", q], opts);
  }
  for (const q of sample(skillQueries.map((x) => (typeof x === "string" ? x : x.query)), 5)) {
    runCli("cli.test-search", ["test-search", q], opts);
  }

  runCli("cli.bundle-list", ["bundle"], opts);
  const cfgBundles = JSON.parse(readFileSync(configPath, "utf8")).bundles ?? [];
  if (cfgBundles.length > 0) {
    runCli("cli.bundle-export", ["bundle", "--export", cfgBundles[0].id], opts);
  } else {
    recordStepNote("cli.bundle-export", "skipped: fixture config declares no bundles");
  }
  runCli("cli.doctor", ["doctor", "--no-check"], opts);
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

function phaseImportMigrate({ perConfig }) {
  // Fresh empty target config for --write; discovery input comes from the
  // isolated fake HOME, not from the curated fixture config.
  const importConfigPath = join(GENERATED, "import-target-servers.json");
  writeFileSync(importConfigPath, JSON.stringify({ autoDiscover: false, servers: [] }));

  const planted = plantHarnessConfigs(env.home, perConfig);
  recordStepNote("fake-home", "planted " + planted + " servers across " + HARNESS_LOCATIONS.length + " harness configs under isolated HOME");

  runCli("cli.import-dry", ["import"], { configPath: importConfigPath });
  runCli("cli.import-write", ["import", "--write"], { configPath: importConfigPath });
  runCli("cli.migrate-plan", ["migrate", "--json"], { configPath: importConfigPath });
  runCli("cli.migrate-write", ["migrate", "--write"], { configPath: importConfigPath });
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
  while (Buffer.byteLength(out) < targetBytes) {
    out += '\n[mcp_servers.padding.' + String(out.length).padStart(6, "0") + ']\n';
    out += 'command = "/bin/echo"\n';
    out += 'args = ["pad"]\n';
  }
  writeFileSync(path, out);
  return Buffer.byteLength(out);
}

function phaseHarnessInstall() {
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
  const r1 = spawnSync(process.execPath, [CLI, "harness", "cursor", "install", "--write"], {
    encoding: "utf8", cwd: cursorHome,
    env: { ...process.env, HOME: cursorHome, XDG_CACHE_HOME: join(env.runRoot, "xdg-cache"), XDG_CONFIG_HOME: join(env.runRoot, "xdg-config"), PI_CODING_AGENT_DIR: join(cursorHome, "pi-agent") },
    maxBuffer: 256 * 1024 * 1024,
  });
  const step1 = {
    step: "cli.harness-cursor-install",
    argv: "action-hub harness cursor install --write (10MB mcp.json)",
    ms: Math.round(performance.now() - t0),
    exit: r1.status,
    stdoutBytes: r1.stdout ? Buffer.byteLength(r1.stdout) : 0,
    stderrBytes: r1.stderr ? Buffer.byteLength(r1.stderr) : 0,
    ok: r1.status === 0,
    stdout: r1.stdout, stderr: r1.stderr,
  };
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

  const t2 = performance.now();
  const r2 = spawnSync(process.execPath, [CLI, "harness", "codex", "install", "--write"], {
    encoding: "utf8", cwd: codexHome,
    env: { ...process.env, HOME: codexHome, XDG_CACHE_HOME: join(env.runRoot, "xdg-cache"), XDG_CONFIG_HOME: join(env.runRoot, "xdg-config"), PI_CODING_AGENT_DIR: join(codexHome, "pi-agent") },
    maxBuffer: 256 * 1024 * 1024,
  });
  const step2 = {
    step: "cli.harness-codex-install",
    argv: "action-hub harness codex install --write (10MB config.toml)",
    ms: Math.round(performance.now() - t2),
    exit: r2.status,
    stdoutBytes: r2.stdout ? Buffer.byteLength(r2.stdout) : 0,
    stderrBytes: r2.stderr ? Buffer.byteLength(r2.stderr) : 0,
    ok: r2.status === 0,
    stdout: r2.stdout, stderr: r2.stderr,
  };
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

function emitSummary(totalMs) {
  const steps = results.map(({ stdout, stderr, ...rest }) => rest);
  const summary = {
    scale: SCALE,
    seed: SEED,
    thresholds: { slowMs: SLOW_MS, largeOutputBytes: LARGE_OUTPUT_BYTES },
    totalMs,
    steps,
    flags,
    ok: steps.every((s) => s.ok === undefined || s.ok === true),
  };
  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(join(RESULTS_DIR, "cli-scale.json"), JSON.stringify(summary, null, 2) + "\n");
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
}

// Exposed for stress/cli-scale.test.mjs (determinism + fake-server handshake).
export const __test = { writeToolManifests, buildConfigSkills, writeSkillFixtures, FAKE_STDIO_SERVER, SCALES, reseed: (seed) => { rng = mulberry32(seed); } };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(String((err && err.stack) || err));
    process.exit(1);
  });
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

  // Isolated run root under stress/.generated/cli-scale/ (never committed).
  const runRoot = join(GENERATED, "cli-scale");
  rmSync(runRoot, { recursive: true, force: true });
  const home = join(runRoot, "home");
  const xdgCache = join(runRoot, "xdg-cache");
  const xdgConfig = join(runRoot, "xdg-config");
  const skillsDir = join(runRoot, "skills");
  for (const d of [home, xdgCache, xdgConfig, skillsDir, join(runRoot, "logs")]) mkdirSync(d, { recursive: true });
  env = { runRoot, home, xdgCache, xdgConfig, skillsDir };
  env = { runRoot, home, xdgCache, xdgConfig, skillsDir };

  // Fixtures: prefer the shared generators' corpus in stress/.generated
  // (tools/*.json + skills/ + servers.json from make-config.mjs); fall back to
  // self-generated small fixtures in the same contract format.
  const sharedToolsDir = join(GENERATED, "tools");
  const sharedServersJson = join(GENERATED, "servers.json");
  const sharedSkills = join(GENERATED, "skills");
  const sharedReady = existsSync(sharedServersJson) && existsSync(sharedToolsDir) &&
    readdirSync(sharedToolsDir).some((f) => f.endsWith(".json") && f !== "tools-queries.json");
  let serverIds, configSkills, configPath, skillSlugs;
  if (sharedReady) {
    env.skillsDir = sharedSkills;
    console.log("using shared fixtures from stress/.generated (tools + skills + servers.json)");
    const base = JSON.parse(readFileSync(sharedServersJson, "utf8"));
    serverIds = base.servers.map((srv) => srv.id);
    // Merge the 5K skills corpus into the config so `list --kind skill` and
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

  const totalTools = cfg.servers * (cfg.servers > cfg.bigServers && cfg.bigServers > 0
    ? (cfg.toolsPerServer * (cfg.servers - cfg.bigServers) + cfg.bigTools * cfg.bigServers) / cfg.servers
    : cfg.toolsPerServer);
  console.log("fixtures: " + cfg.servers + " servers, ~" + totalTools + " tools, " + configSkills.length + " skills, " +
    cfg.harnessServersPerConfig + " servers per harness config for import/migrate");

  phaseCliBenchmarks({ configPath, serverIds });
  phaseImportMigrate({ perConfig: cfg.harnessServersPerConfig });
  phaseHarnessInstall();
}
