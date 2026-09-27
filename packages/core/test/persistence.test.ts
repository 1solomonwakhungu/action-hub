import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ActionHub } from "../dist/action-hub.js";
import {
  CATALOG_CACHE_VERSION,
  CatalogCache,
  defaultCatalogCachePath,
  hashServerConfigs,
} from "../dist/catalog/persistence.js";
import { bootstrapCatalog } from "../dist/catalog/bootstrap.js";
import type { PersistedCatalog } from "../dist/catalog/persistence.js";
import type { ServerConfig } from "../dist/types.js";
import { FakeClient, makeFactory } from "./fakes.ts";
import { testActionHub } from "./test-hub.ts";

const servers: ServerConfig[] = [
  { id: "github", transport: { type: "stdio", command: "gh-mcp" }, trust: "trusted" },
  { id: "slack", transport: { type: "stdio", command: "slack-mcp" }, trust: "untrusted" },
];

/** Never touch the real user cache dir. */
async function tempCachePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "action-hub-cache-"));
  return join(dir, "catalog.json");
}

function buildHub(overrides: Partial<ConstructorParameters<typeof ActionHub>[0]> = {}) {
  const clients = {
    github: new FakeClient([
      {
        name: "create_pull_request",
        description: "Open a new pull request.",
        inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
      },
      { name: "list_issues", description: "List repository issues", inputSchema: { type: "object" } },
    ]),
    slack: new FakeClient([
      { name: "post_message", description: "Post a Slack message", inputSchema: { type: "object" } },
    ]),
  };
  const { factory, activations } = makeFactory(clients);
  const hub = testActionHub({  servers, clientFactory: factory, ...overrides });
  return { hub, clients, activations };
}

test("cache path honours XDG_CACHE_HOME", () => {
  const path = defaultCatalogCachePath({ XDG_CACHE_HOME: "/xdg" });
  assert.equal(path, resolve("/xdg", "action-hub", "catalog.json"));
});

test("cache path falls back to ~/.cache when XDG is unset", () => {
  const path = defaultCatalogCachePath({});
  assert.match(path, /[/\\]\.cache[/\\]action-hub[/\\]catalog\.json$/);
});

test("ACTION_HUB_CACHE overrides every other cache location", () => {
  const path = defaultCatalogCachePath({ ACTION_HUB_CACHE: "/tmp/x.json", XDG_CACHE_HOME: "/xdg" });
  assert.equal(path, "/tmp/x.json");
});

test("config hash is stable across server ordering", () => {
  const reversed = [...servers].reverse();
  assert.equal(hashServerConfigs(servers), hashServerConfigs(reversed));
});

test("config hash changes when the command changes", () => {
  const changed: ServerConfig[] = [
    { ...servers[0]!, transport: { type: "stdio", command: "gh-mcp-v2" } },
    servers[1]!,
  ];
  assert.notEqual(hashServerConfigs(servers), hashServerConfigs(changed));
});

test("config hash changes when args, trust, or allow-lists change", () => {
  const base = hashServerConfigs(servers);
  const withArgs: ServerConfig[] = [
    { ...servers[0]!, transport: { type: "stdio", command: "gh-mcp", args: ["--verbose"] } },
    servers[1]!,
  ];
  const withTrust: ServerConfig[] = [{ ...servers[0]!, trust: "untrusted" }, servers[1]!];
  const withAllow: ServerConfig[] = [{ ...servers[0]!, allowTools: ["list_issues"] }, servers[1]!];

  assert.notEqual(hashServerConfigs(withArgs), base);
  assert.notEqual(hashServerConfigs(withTrust), base);
  assert.notEqual(hashServerConfigs(withAllow), base);
});

test("env keys invalidate the cache but env values do not", () => {
  const withToken: ServerConfig[] = [
    { ...servers[0]!, transport: { type: "stdio", command: "gh-mcp", env: { TOKEN: "one" } } },
  ];
  const rotated: ServerConfig[] = [
    { ...servers[0]!, transport: { type: "stdio", command: "gh-mcp", env: { TOKEN: "two" } } },
  ];
  const extraKey: ServerConfig[] = [
    {
      ...servers[0]!,
      transport: { type: "stdio", command: "gh-mcp", env: { TOKEN: "one", OTHER: "x" } },
    },
  ];

  assert.equal(hashServerConfigs(withToken), hashServerConfigs(rotated));
  assert.notEqual(hashServerConfigs(withToken), hashServerConfigs(extraKey));
});

test("http url and header keys participate in the hash", () => {
  const a: ServerConfig[] = [{ id: "x", transport: { type: "http", url: "https://a.example" } }];
  const b: ServerConfig[] = [{ id: "x", transport: { type: "http", url: "https://b.example" } }];
  const c: ServerConfig[] = [
    { id: "x", transport: { type: "http", url: "https://a.example", headers: { Auth: "t" } } },
  ];

  assert.notEqual(hashServerConfigs(a), hashServerConfigs(b));
  assert.notEqual(hashServerConfigs(a), hashServerConfigs(c));
});

test("a missing cache file reads as undefined without warning", async () => {
  const warnings: string[] = [];
  const cache = new CatalogCache({
    path: join(await mkdtemp(join(tmpdir(), "action-hub-missing-")), "catalog.json"),
    onWarning: (message) => warnings.push(message),
  });

  assert.equal(await cache.read(), undefined);
  assert.deepEqual(warnings, []);
});

test("a corrupt cache file is ignored rather than thrown", async () => {
  const path = await tempCachePath();
  await writeFile(path, "{ not json at all", "utf8");

  const warnings: string[] = [];
  const cache = new CatalogCache({ path, onWarning: (message) => warnings.push(message) });

  assert.equal(await cache.read(), undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /not valid JSON/);
});

test("a structurally wrong cache file is ignored", async () => {
  const path = await tempCachePath();
  await writeFile(path, JSON.stringify({ hello: "world" }), "utf8");

  const cache = new CatalogCache({ path });
  assert.equal(await cache.read(), undefined);
});

test("an unreadable cache directory degrades to undefined", async () => {
  const dir = await mkdtemp(join(tmpdir(), "action-hub-unreadable-"));
  const path = join(dir, "catalog.json");
  await mkdir(path); // a directory where a file is expected

  const warnings: string[] = [];
  const cache = new CatalogCache({ path, onWarning: (message) => warnings.push(message) });

  assert.equal(await cache.read(), undefined);
  assert.equal(warnings.length, 1);
});

test("a stale schema version invalidates the entry", async () => {
  const path = await tempCachePath();
  const { hub } = buildHub();
  await hub.indexAll();

  const entry = hub.toPersisted("hash-a") as PersistedCatalog;
  await writeFile(path, JSON.stringify({ ...entry, version: CATALOG_CACHE_VERSION - 1 }), "utf8");

  const warnings: string[] = [];
  const cache = new CatalogCache({ path, onWarning: (message) => warnings.push(message) });

  assert.notEqual(await cache.read(), undefined);
  assert.equal(await cache.load("hash-a"), undefined);
  assert.match(warnings.join(" "), /re-indexing/);
});

test("a changed config hash invalidates the entry", async () => {
  const path = await tempCachePath();
  const { hub } = buildHub();
  await hub.indexAll();

  const cache = new CatalogCache({ path });
  assert.equal(await cache.write(hub.toPersisted("hash-a")), true);

  assert.notEqual(await cache.load("hash-a"), undefined);
  assert.equal(await cache.load("hash-b"), undefined);
});

test("a written entry round-trips with every action", async () => {
  const path = await tempCachePath();
  const { hub } = buildHub();
  await hub.indexAll();

  const cache = new CatalogCache({ path });
  await cache.write(hub.toPersisted("hash-a"));

  const entry = await cache.load("hash-a");
  assert.ok(entry);
  assert.equal(entry.version, CATALOG_CACHE_VERSION);
  assert.equal(entry.actions.length, 3);
  const pr = entry.actions.find((action) => action.id === "github:create_pull_request");
  assert.ok(pr);
  assert.deepEqual(pr.inputSchema, {
    type: "object",
    properties: { title: { type: "string" } },
    required: ["title"],
  });
});

test("the persisted entry keeps every diagnostic field hosts read", async () => {
  const path = await tempCachePath();
  const { hub } = buildHub();
  await hub.indexAll();

  const cache = new CatalogCache({ path });
  await cache.write(hub.toPersisted("hash-a"));

  const onDisk = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  for (const key of ["indexedAt", "servers", "skills", "context", "history"]) {
    assert.ok(key in onDisk, `snapshot field "${key}" is missing from the cache file`);
  }
  const servers = onDisk["servers"] as Record<string, { toolCount: number }>;
  assert.equal(servers["github"]!.toolCount, 2);
  assert.equal(servers["slack"]!.toolCount, 1);
});

test("individual malformed actions are dropped, not the whole file", async () => {
  const path = await tempCachePath();
  const { hub } = buildHub();
  await hub.indexAll();

  const entry = hub.toPersisted("hash-a") as PersistedCatalog;
  const corrupted = {
    ...entry,
    actions: [...entry.actions, { id: "broken" }, null, { id: "x", serverId: "y", name: "z" }],
  };
  await writeFile(path, JSON.stringify(corrupted), "utf8");

  const loaded = await new CatalogCache({ path }).load("hash-a");
  assert.ok(loaded);
  assert.equal(loaded.actions.length, 3);
});

test("concurrent writes never publish a corrupt or partial file", async () => {
  const path = await tempCachePath();
  const { hub } = buildHub();
  await hub.indexAll();

  const cache = new CatalogCache({ path });

  // Fan out many writes on one instance at once, mimicking the host firing an
  // unawaited snapshot after every execute while the background refresh writes
  // too. Each carries a distinct configHash so we can prove last-enqueued-wins.
  const count = 40;
  const results = await Promise.all(
    Array.from({ length: count }, (_, i) => cache.write(hub.toPersisted(`hash-${i}`))),
  );

  // Every write reports success and the file on disk is always complete JSON.
  assert.ok(results.every((ok) => ok === true));

  const onDisk = JSON.parse(await readFile(path, "utf8")) as PersistedCatalog;
  assert.equal(onDisk.version, CATALOG_CACHE_VERSION);
  assert.equal(onDisk.actions.length, 3);
  assert.ok(onDisk.actions.every((action) => typeof action.id === "string" && action.id.length > 0));

  // Serialisation means the last enqueued write is the one that lands.
  assert.equal(onDisk.configHash, `hash-${count - 1}`);

  // No temp files are left behind once the chain settles.
  const dir = join(path, "..");
  const leftovers = (await readdir(dir)).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(leftovers, []);
});

test("interleaved reads during concurrent writes always parse", async () => {
  const path = await tempCachePath();
  const { hub } = buildHub();
  await hub.indexAll();

  const cache = new CatalogCache({ path });
  await cache.write(hub.toPersisted("seed"));

  const writes = Array.from({ length: 25 }, (_, i) => cache.write(hub.toPersisted(`hash-${i}`)));

  // Hammer the path with reads while writes are in flight; a non-atomic write
  // would occasionally surface a truncated file that fails to parse.
  const reads = Array.from({ length: 60 }, async () => {
    try {
      const raw = await readFile(path, "utf8");
      JSON.parse(raw);
      return true;
    } catch {
      return false;
    }
  });

  const [, readOutcomes] = await Promise.all([Promise.all(writes), Promise.all(reads)]);
  assert.ok(readOutcomes.every((ok) => ok === true));
});

test("the cache directory and file are written with private permissions", async () => {
  if (process.platform === "win32") return; // POSIX mode bits are meaningless here.

  const dir = await mkdtemp(join(tmpdir(), "action-hub-perms-"));
  const path = join(dir, "nested", "catalog.json");
  const { hub } = buildHub();
  await hub.indexAll();

  assert.equal(await new CatalogCache({ path }).write(hub.toPersisted("hash-a")), true);

  const fileMode = (await stat(path)).mode & 0o777;
  const dirMode = (await stat(join(path, ".."))).mode & 0o777;
  assert.equal(fileMode, 0o600);
  assert.equal(dirMode, 0o700);
});

test("a write to an unwritable location returns false instead of throwing", async () => {  const dir = await mkdtemp(join(tmpdir(), "action-hub-readonly-"));
  const nested = join(dir, "nested");
  await mkdir(nested);
  await chmod(nested, 0o500);

  const warnings: string[] = [];
  const cache = new CatalogCache({
    path: join(nested, "catalog.json"),
    onWarning: (message) => warnings.push(message),
  });
  const { hub } = buildHub();
  await hub.indexAll();

  assert.equal(await cache.write(hub.toPersisted("hash-a")), false);
  assert.equal(warnings.length, 1);

  await chmod(nested, 0o700);
});

test("restoreCatalog rehydrates search and load without connecting", async () => {
  const path = await tempCachePath();
  const seed = buildHub();
  await seed.hub.indexAll();
  await new CatalogCache({ path }).write(seed.hub.toPersisted("hash-a"));

  const entry = await new CatalogCache({ path }).load("hash-a");
  assert.ok(entry);

  const restored = buildHub();
  const count = restored.hub.restoreCatalog(entry);

  assert.equal(count, 3);
  assert.deepEqual(restored.activations, []);
  const hits = await restored.hub.search("open a pull request");
  assert.equal(hits[0]?.id, "github:create_pull_request");
  assert.deepEqual(restored.hub.load("github:create_pull_request").inputSchema, {
    type: "object",
    properties: { title: { type: "string" } },
    required: ["title"],
  });
});

test("restoreCatalog drops actions for servers no longer configured", async () => {
  const seed = buildHub();
  await seed.hub.indexAll();
  const entry = seed.hub.toPersisted("hash-a") as PersistedCatalog;

  const { factory } = makeFactory({ github: new FakeClient([]) });
  const trimmed = testActionHub({  servers: [servers[0]!], clientFactory: factory });

  assert.equal(trimmed.restoreCatalog(entry), 2);
  assert.equal(trimmed.catalog.get("slack:post_message"), undefined);
});

test("restoreCatalog replaces any previously indexed state", async () => {
  const { hub } = buildHub();
  await hub.indexAll();
  assert.equal(hub.catalog.size, 3);

  const empty: PersistedCatalog = {
    version: CATALOG_CACHE_VERSION,
    configHash: "hash-a",
    indexedAt: new Date().toISOString(),
    actions: [],
    servers: {},
    skills: 0,
    context: { actions: 0, eagerTokensEstimate: 0, hubTokensEstimate: 0 },
    history: [],
  };

  assert.equal(hub.restoreCatalog(empty), 0);
  assert.equal(hub.catalog.size, 0);
});

test("a cold bootstrap indexes and writes the cache", async () => {
  const path = await tempCachePath();
  const { hub, activations } = buildHub();

  const result = await bootstrapCatalog(hub, { servers, path });
  await result.refreshed;

  assert.equal(result.fromCache, false);
  assert.equal(result.actions, 3);
  assert.deepEqual(activations.sort(), ["github", "slack"]);

  const entry = await new CatalogCache({ path }).load(result.configHash);
  assert.ok(entry);
  assert.equal(entry.actions.length, 3);
});

test("a warm bootstrap serves from cache without indexing first", async () => {
  const path = await tempCachePath();
  const cold = buildHub();
  await (await bootstrapCatalog(cold.hub, { servers, path })).refreshed;

  const warm = buildHub();
  const result = await bootstrapCatalog(warm.hub, {
    servers,
    path,
    refreshInBackground: false,
  });

  assert.equal(result.fromCache, true);
  assert.equal(result.actions, 3);
  assert.deepEqual(warm.activations, []);
});

test("a warm bootstrap still re-indexes in the background", async () => {
  const path = await tempCachePath();
  const cold = buildHub();
  await (await bootstrapCatalog(cold.hub, { servers, path })).refreshed;

  const warm = buildHub();
  const result = await bootstrapCatalog(warm.hub, { servers, path });

  assert.equal(result.fromCache, true);
  const results = await result.refreshed;
  assert.equal(results.length, 2);
  assert.deepEqual(warm.activations.sort(), ["github", "slack"]);
  assert.equal(warm.hub.catalog.size, 3);
});

test("a changed server config forces a cold bootstrap", async () => {
  const path = await tempCachePath();
  const cold = buildHub();
  await (await bootstrapCatalog(cold.hub, { servers, path })).refreshed;

  const changed: ServerConfig[] = [
    { ...servers[0]!, transport: { type: "stdio", command: "gh-mcp", args: ["--new"] } },
    servers[1]!,
  ];
  const next = buildHub();
  const result = await bootstrapCatalog(next.hub, { servers: changed, path });

  assert.equal(result.fromCache, false);
  assert.deepEqual(next.activations.sort(), ["github", "slack"]);
});

test("a corrupt cache falls back to a full index instead of crashing", async () => {
  const path = await tempCachePath();
  await writeFile(path, "\u0000\u0000not-json", "utf8");

  const { hub, activations } = buildHub();
  const warnings: string[] = [];
  const result = await bootstrapCatalog(hub, {
    servers,
    path,
    onWarning: (message) => warnings.push(message),
  });
  await result.refreshed;

  assert.equal(result.fromCache, false);
  assert.equal(result.actions, 3);
  assert.deepEqual(activations.sort(), ["github", "slack"]);
  assert.equal(warnings.length, 1);
});

test("a failing background re-index leaves the cached catalog usable", async () => {
  const path = await tempCachePath();
  const cold = buildHub();
  await (await bootstrapCatalog(cold.hub, { servers, path })).refreshed;

  const failing = async (): Promise<never> => {
    throw new Error("downstream unreachable");
  };
  const hub = testActionHub({  servers, clientFactory: failing });

  const result = await bootstrapCatalog(hub, { servers, path });
  assert.equal(result.fromCache, true);
  assert.equal(result.actions, 3);

  const results = await result.refreshed;
  assert.equal(results.length, 2);
  assert.ok(results.every((entry) => entry.error));
  // The stale catalog survives a refresh that indexed nothing.
  const hits = await hub.search("pull request");
  assert.ok(hits.length > 0);
});

test("a cold bootstrap that cannot write the cache still returns a catalog", async () => {
  const dir = await mkdtemp(join(tmpdir(), "action-hub-nowrite-"));
  const nested = join(dir, "nested");
  await mkdir(nested);
  await chmod(nested, 0o500);

  const { hub } = buildHub();
  const warnings: string[] = [];
  const result = await bootstrapCatalog(hub, {
    servers,
    path: join(nested, "catalog.json"),
    onWarning: (message) => warnings.push(message),
  });
  await result.refreshed;

  assert.equal(result.actions, 3);
  assert.equal(warnings.length, 1);

  await chmod(nested, 0o700);
});

test("a deferred warm bootstrap serves the cache and re-indexes only on startRefresh", async () => {
  const path = await tempCachePath();
  const cold = buildHub();
  const coldResult = await bootstrapCatalog(cold.hub, { servers, path });
  await coldResult.refreshed;

  const warm = buildHub();
  const result = await bootstrapCatalog(warm.hub, { servers, path, deferRefresh: true });

  // Served from cache; the authoritative re-index has NOT run yet.
  assert.equal(result.fromCache, true);
  assert.equal(result.actions, 3);
  assert.deepEqual(warm.activations, []);

  // startRefresh is memoised: repeated calls share one re-index.
  const first = result.startRefresh();
  const second = result.startRefresh();
  assert.equal(first, second);
  const results = await first;
  assert.deepEqual(warm.activations.sort(), ["github", "slack"]);
  assert.equal(results.length, 2);

  // The refreshed write-back persists the authoritative catalog.
  const entry = await new CatalogCache({ path }).load(result.configHash);
  assert.ok(entry);
  assert.equal(entry.actions.length, 3);
});

test("a deferred warm bootstrap never started leaves activations empty", async () => {
  const path = await tempCachePath();
  const cold = buildHub();
  await (await bootstrapCatalog(cold.hub, { servers, path })).refreshed;

  const warm = buildHub();
  const result = await bootstrapCatalog(warm.hub, { servers, path, deferRefresh: true });
  assert.equal(result.fromCache, true);
  assert.deepEqual(warm.activations, []);
  // The host never calls startRefresh(); nothing re-indexes behind its back.
  await warm.hub.close();
  assert.deepEqual(warm.activations, []);
});

test("F69: the post-embedding vector write is tracked, not fire-and-forget", async () => {
  // Deterministic probe (reviewer-2, PR 102 rework): a CatalogCache whose
  // SECOND write blocks must leave bootstrap.vectorsWritten() pending until
  // the write settles — so a host's shutdown path can drain it instead of
  // resolving close() while cache.json.tmp is still being renamed.
  let writes = 0;
  let releaseSecond!: (value: void) => void;
  const secondGate = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  const fake = {
    async load() {
      return null; // cold start
    },
    async write() {
      writes += 1;
      if (writes >= 2) return secondGate;
    },
  } as unknown as CatalogCache;

  const { hub } = buildHub({ embeddings: null });
  const boot = await bootstrapCatalog(hub, { servers, cache: fake });
  assert.equal(boot.fromCache, false);

  let settled = false;
  void boot.vectorsWritten().then(() => {
    settled = true;
  });
  await new Promise((done) => setImmediate(done));
  await new Promise((done) => setImmediate(done));
  assert.equal(writes, 2, "the post-semantic vector write must be scheduled");
  assert.equal(settled, false, "vectorsWritten must stay pending while the vector write is in flight");

  releaseSecond(undefined);
  await boot.vectorsWritten();
  assert.equal(settled, true, "vectorsWritten resolves once the write settles");
  await hub.close();
});

test("F69 rework: the stable drain covers a write scheduled by a later startRefresh", async () => {
  // Deferred mode: an EARLY vectorsWritten() call (before startRefresh) is
  // quiescent by contract (a never-started refresh schedules nothing); the
  // caller that matters — a shutdown path after startRefresh — must observe
  // the write the refresh schedules, even when that write blocks.
  let writes = 0;
  let releaseSecond!: (value: void) => void;
  const secondGate = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  const fake = {
    async load() {
      return { actions: [], configHash: "hash-a", version: CATALOG_CACHE_VERSION }; // warm start
    },
    async write() {
      writes += 1;
      if (writes >= 2) return secondGate;
    },
  } as unknown as CatalogCache;

  const { hub } = buildHub({ embeddings: null });
  const boot = await bootstrapCatalog(hub, { servers, cache: fake, deferRefresh: true });

  let earlySettled = false;
  void boot.vectorsWritten().then(() => {
    earlySettled = true;
  });
  await new Promise((done) => setImmediate(done));
  assert.equal(earlySettled, true, "an early call is quiescent (documented): no refresh started, no write scheduled");

  await boot.startRefresh();
  // Post-refresh drain must observe the write the refresh scheduled, even
  // while it is blocked.
  let drained = false;
  const drain = boot.vectorsWritten().then(() => {
    drained = true;
  });
  await new Promise((done) => setImmediate(done));
  assert.equal(writes, 2, "the refresh scheduled the post-embedding vector write");
  assert.equal(drained, false, "the drain stays pending while the scheduled write is in flight");
  releaseSecond(undefined);
  await drain;
  assert.equal(drained, true, "the drain resolves once the scheduled write settles");
  await hub.close();
});
