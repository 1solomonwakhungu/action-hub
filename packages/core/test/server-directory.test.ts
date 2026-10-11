import assert from "node:assert/strict";
import { test } from "node:test";
import { buildServerDirectory, DEFAULT_DIRECTORY_KEYWORDS } from "../dist/search/server-directory.js";
import { QUERY_STOPWORDS } from "../dist/search/search.js";
import { testActionHub } from "./test-hub.ts";
import type { ActionRecord, McpClient } from "../dist/types.js";

/**
 * Compressed domain/server awareness (r/mcp follow-up 4).
 *
 * The directory exists so a model facing a vague, goal-only ask can learn
 * WHICH integrations exist before (or instead of) guessing a search phrase.
 * These tests pin the properties that make it useful: distinctive words win
 * over shared vocabulary, the output is tiny and deterministic, and the hub
 * memoizes it until the catalog actually changes.
 */

function record(serverId: string, name: string, summary: string, description?: string): ActionRecord {
  return { id: `${serverId}:${name}`, kind: "tool", serverId, name, summary, description, trust: "trusted" };
}

/** Three servers sharing generic verbs but each owning its own domain nouns. */
function corpus(): ActionRecord[] {
  return [
    record("payroll", "list_employees", "List employees and their payroll status", "Payroll runs and pay stubs for employees."),
    record("payroll", "create_payslip", "Create a payslip for an employee", "Payroll payslip generation."),
    record("payroll", "approve_timesheet", "Approve a timesheet before the payroll run", "Timesheet approval for payroll."),
    record("github", "list_issues", "List issues in a repository", "Repository issues and pull requests."),
    record("github", "create_pull_request", "Create a pull request against a branch", "Open a pull request in the repository."),
    record("github", "merge_pull_request", "Merge a pull request", "Merge the pull request into its base branch."),
    record("slack", "list_channels", "List channels in the workspace", "Chat channels and threads."),
    record("slack", "create_channel", "Create a chat channel", "Creates a new channel for the team."),
    record("slack", "post_message", "Post a message to a channel", "Send a chat message to a channel or thread."),
  ];
}

test("keywords favour each server's own domain vocabulary over shared verbs", () => {
  const entries = buildServerDirectory(corpus(), { keywordsPerServer: 4 });
  assert.deepEqual(entries.map((entry) => entry.serverId), ["github", "payroll", "slack"], "sorted by server id");
  const byId = new Map(entries.map((entry) => [entry.serverId, entry]));

  // The server id's own tokens ("payroll") are excluded because the id is
  // already in the entry; the remaining words must still name the domain.
  const payroll = byId.get("payroll")!.keywords;
  assert.ok(!payroll.includes("payroll"), `server id token leaked: ${payroll}`);
  assert.ok(payroll.includes("employee") || payroll.includes("payslip") || payroll.includes("timesheet"), `payroll keywords: ${payroll}`);
  assert.ok(byId.get("github")!.keywords.includes("pull") || byId.get("github")!.keywords.includes("repository"));
  assert.ok(byId.get("slack")!.keywords.includes("channel") || byId.get("slack")!.keywords.includes("chat"));

  // "list" and "create" appear on every server: they must never outrank the
  // domain nouns, otherwise the directory tells the model nothing.
  for (const entry of entries) {
    assert.ok(!entry.keywords.includes("list"), `${entry.serverId} surfaced the generic verb "list": ${entry.keywords}`);
    assert.ok(!entry.keywords.includes("create"), `${entry.serverId} surfaced the generic verb "create": ${entry.keywords}`);
  }
});

test("entries carry counts, kinds, and optional config metadata", () => {
  const records = [...corpus(), { ...record("skills", "release-checklist", "Cut a release safely"), kind: "skill" as const }];
  const metadata = new Map([["payroll", { displayName: "Payroll (ADP)", description: "HR payroll runs for EU staff" }]]);
  const entries = buildServerDirectory(records, { metadata });
  const payroll = entries.find((entry) => entry.serverId === "payroll")!;
  assert.equal(payroll.actionCount, 3);
  assert.deepEqual(payroll.kinds, ["tool"]);
  assert.equal(payroll.displayName, "Payroll (ADP)");
  assert.equal(payroll.description, "HR payroll runs for EU staff");

  const skills = entries.find((entry) => entry.serverId === "skills")!;
  assert.deepEqual(skills.kinds, ["skill"]);
  assert.equal(skills.actionCount, 1);

  const github = entries.find((entry) => entry.serverId === "github")!;
  assert.equal(github.displayName, undefined, "no metadata means no key, not an empty string");
  assert.equal("description" in github, false);
});

test("keywords exclude stopwords, short tokens, numbers, and the server's own id tokens", () => {
  const noisy = [
    record("acme-crm", "get_the_lead", "Get the lead by id 42", "The lead and its account in the acme crm, version 2."),
    record("acme-crm", "list_leads", "List leads in the crm", "Leads and accounts of the acme crm."),
    record("other", "ping", "Ping the service", "Health check."),
  ];
  const entry = buildServerDirectory(noisy).find((e) => e.serverId === "acme-crm")!;
  for (const keyword of entry.keywords) {
    assert.ok(!QUERY_STOPWORDS.has(keyword), `stopword leaked: ${keyword}`);
    assert.ok(keyword.length >= 3, `short token leaked: ${keyword}`);
    assert.ok(!/^\d+$/.test(keyword), `number leaked: ${keyword}`);
    assert.ok(keyword !== "acme" && keyword !== "crm", `server id token leaked: ${keyword}`);
  }
  assert.ok(entry.keywords.includes("lead") || entry.keywords.includes("leads"));
});

test("keyword count defaults, clamps, and the output is deterministic and compact", () => {
  const records = corpus();
  assert.equal(buildServerDirectory(records)[0]!.keywords.length <= DEFAULT_DIRECTORY_KEYWORDS, true);
  assert.equal(buildServerDirectory(records, { keywordsPerServer: 0 })[0]!.keywords.length, 0);
  assert.equal(buildServerDirectory(records, { keywordsPerServer: 2 })[0]!.keywords.length, 2);
  assert.equal(
    buildServerDirectory(records, { keywordsPerServer: Number.NaN })[0]!.keywords.length <= DEFAULT_DIRECTORY_KEYWORDS,
    true,
  );
  assert.equal(buildServerDirectory(records, { keywordsPerServer: 1000 })[0]!.keywords.length <= 32, true);

  // Same input, byte-identical output: hosts may compare tool results.
  const a = JSON.stringify(buildServerDirectory(records));
  const b = JSON.stringify(buildServerDirectory([...records].reverse()));
  assert.equal(a, b, "record order must not change the directory");

  // "Compressed" is a measurable claim: a 40-server catalog of 50 tools each
  // must stay well under the cost of a single search page.
  const big: ActionRecord[] = [];
  for (let s = 0; s < 40; s += 1) {
    for (let t = 0; t < 50; t += 1) {
      big.push(record(`server-${s}`, `verb${t % 7}_noun${s}_${t}`, `Does noun${s} thing ${t} for domain${s} workflows`));
    }
  }
  const bytes = Buffer.byteLength(JSON.stringify(buildServerDirectory(big)), "utf8");
  assert.ok(bytes < 8 * 1024, `directory for 40 servers is ${bytes} bytes; expected under 8 KiB`);
});

test("an empty catalog yields an empty directory", () => {
  assert.deepEqual(buildServerDirectory([]), []);
});

test("words shared by most servers are never padded in as keywords", () => {
  // Every server says "workspace" and "idempotency"; only one word per server
  // is distinctive. Rows must stop at the distinctive word rather than fill
  // the budget with the shared boilerplate.
  const records = ["alpha", "beta", "gamma", "delta"].map((id) =>
    record(id, `${id}_tool`, `Handles ${id}ish records in the workspace with idempotency keys`),
  );
  for (const entry of buildServerDirectory(records)) {
    assert.deepEqual(entry.keywords, [`${entry.serverId}ish`], `${entry.serverId}: ${entry.keywords}`);
  }
  // A single-server catalog has no contrast and ranks by coverage instead.
  const solo = buildServerDirectory(records.slice(0, 1));
  assert.ok(solo[0]!.keywords.length > 1);
});

test("ActionHub.serverDirectory merges config metadata and memoizes until the catalog changes", async () => {
  const clientFor = (tools: Array<{ name: string; description: string }>): McpClient => ({
    listTools: async () => tools.map((tool) => ({ ...tool, inputSchema: { type: "object" } })),
    callTool: async () => ({}),
    close: async () => {},
  });
  const hub = testActionHub({
    servers: [
      {
        id: "jira",
        displayName: "Jira Cloud",
        description: "Tickets for the payments team",
        transport: { type: "stdio", command: "fake" },
        trust: "trusted",
      },
      { id: "s3", transport: { type: "stdio", command: "fake" }, trust: "trusted" },
    ],
    clientFactory: async (config) =>
      config.id === "jira"
        ? clientFor([
            { name: "create_issue", description: "Create a Jira ticket in a project sprint" },
            { name: "transition_issue", description: "Move a ticket across sprint board columns" },
          ])
        : clientFor([
            { name: "put_object", description: "Upload an object into a storage bucket" },
            { name: "list_objects", description: "List objects in a storage bucket" },
          ]),
  });
  await hub.indexAll();

  const first = hub.serverDirectory();
  assert.deepEqual(first.map((entry) => entry.serverId), ["jira", "s3"]);
  const jira = first[0]!;
  assert.equal(jira.displayName, "Jira Cloud");
  assert.equal(jira.description, "Tickets for the payments team");
  assert.equal(jira.actionCount, 2);
  assert.ok(jira.keywords.includes("ticket") || jira.keywords.includes("sprint"), `jira keywords: ${jira.keywords}`);
  const s3 = first[1]!;
  assert.ok(s3.keywords.includes("bucket") || s3.keywords.includes("storage"), `s3 keywords: ${s3.keywords}`);

  // Memoized: a second call over an unchanged catalog is equal but is a fresh
  // copy, so a caller mutating the result cannot poison later responses.
  const second = hub.serverDirectory();
  assert.deepEqual(second, first);
  second[0]!.keywords.push("poison");
  assert.ok(!hub.serverDirectory()[0]!.keywords.includes("poison"));

  // Catalog change invalidates the memo.
  hub.registerSkills([
    { id: "skill:release", serverId: "skills", name: "Release checklist", summary: "Cut a release and publish release notes", trust: "trusted" },
  ]);
  const third = hub.serverDirectory();
  assert.deepEqual(third.map((entry) => entry.serverId), ["jira", "s3", "skills"]);
  assert.deepEqual(third[2]!.kinds, ["skill"]);

  // Different keyword budgets share one memo: the smaller list is a prefix
  // of the larger one (the ranking is total and budget-independent), so the
  // compact and full forms never evict each other.
  const one = hub.serverDirectory({ keywordsPerServer: 1 });
  const eight = hub.serverDirectory();
  assert.equal(one[0]!.keywords.length, 1);
  assert.deepEqual(one[0]!.keywords, eight[0]!.keywords.slice(0, 1));
  assert.deepEqual(hub.serverDirectory({ keywordsPerServer: 4 })[1]!.keywords, eight[1]!.keywords.slice(0, 4));
  await hub.close();
});
