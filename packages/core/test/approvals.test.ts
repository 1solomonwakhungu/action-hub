import assert from "node:assert/strict";
import { test } from "node:test";
import { ActionHub } from "../dist/action-hub.js";
import { ApprovalRegistry, fingerprintArguments } from "../dist/permissions/approvals.js";
import { PermissionPolicy } from "../dist/permissions/policy.js";
import type { ServerConfig } from "../dist/types.js";
import { FakeClient, makeFactory } from "./fakes.ts";

const servers: ServerConfig[] = [
  { id: "github", transport: { type: "stdio", command: "gh-mcp" }, trust: "trusted" },
  { id: "slack", transport: { type: "stdio", command: "slack-mcp" }, trust: "untrusted" },
];

function buildClients() {
  return {
    github: new FakeClient([
      {
        name: "create_pull_request",
        description: "Open a new pull request.",
        inputSchema: {
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"],
        },
      },
    ]),
    slack: new FakeClient([
      {
        name: "post_message",
        description: "Post a Slack message",
        inputSchema: {
          type: "object",
          properties: { channel: { type: "string" }, text: { type: "string" } },
        },
      },
      {
        name: "upload_file",
        description: "Upload a file to Slack",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    ]),
  };
}

function buildHub(overrides: Partial<ConstructorParameters<typeof ActionHub>[0]> = {}) {
  const clients = buildClients();
  const { factory, activations } = makeFactory(clients);
  const hub = new ActionHub({ servers, clientFactory: factory, ...overrides });
  return { hub, clients, activations };
}

/** A gated call must produce a token and reach nobody downstream. */
async function requestApproval(
  hub: ActionHub,
  actionId: string,
  args: Record<string, unknown>,
): Promise<string> {
  const gated = await hub.execute(actionId, args);
  assert.equal(gated.ok, false, "gated execute must not succeed");
  assert.ok(gated.approval, "gated execute must return an approval request");
  return gated.approval.approvalToken;
}

test("an untrusted action is gated, not executed", async () => {
  const { hub, clients } = buildHub();
  await hub.indexAll();

  const result = await hub.execute("slack:post_message", { channel: "#general", text: "hi" });

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /Approval required/);
  // Nothing ran: the whole point of the gate.
  assert.equal(clients.slack.calls.length, 0);

  const approval = result.approval;
  assert.ok(approval);
  assert.equal(approval.status, "approval_required");
  assert.equal(approval.actionId, "slack:post_message");
  assert.equal(approval.serverId, "slack");
  assert.equal(approval.name, "post_message");
  assert.equal(approval.trust, "untrusted");
  assert.deepEqual(approval.argumentKeys, ["channel", "text"]);
  assert.match(approval.argumentsSummary, /channel="#general"/);
  assert.ok(approval.approvalToken.length > 0);
  assert.ok(Date.parse(approval.expiresAt) > Date.parse(approval.issuedAt));

  // The gate is recorded so the history surface can show what was asked for.
  const last = hub.history().at(-1);
  assert.equal(last?.ok, false);
  assert.equal(last?.approval, "required");
});

test("a valid token authorizes exactly one execution", async () => {
  const { hub, clients } = buildHub();
  await hub.indexAll();

  const args = { channel: "#general", text: "hi" };
  const token = await requestApproval(hub, "slack:post_message", args);

  const approved = await hub.execute("slack:post_message", args, { approvalToken: token });
  assert.equal(approved.ok, true);
  assert.equal(approved.content, "ok:post_message");
  assert.equal(clients.slack.calls.length, 1);
  assert.equal(hub.history().at(-1)?.approval, "approved");

  // Replaying the same token must not buy a second call.
  const replay = await hub.execute("slack:post_message", args, { approvalToken: token });
  assert.equal(replay.ok, false);
  assert.match(replay.error ?? "", /Approval rejected/);
  assert.equal(clients.slack.calls.length, 1);
});

test("a token issued for other arguments is rejected", async () => {
  const { hub, clients } = buildHub();
  await hub.indexAll();

  const token = await requestApproval(hub, "slack:post_message", {
    channel: "#general",
    text: "hi",
  });

  const swapped = await hub.execute(
    "slack:post_message",
    { channel: "#executives", text: "hi" },
    { approvalToken: token },
  );

  assert.equal(swapped.ok, false);
  assert.match(swapped.error ?? "", /different arguments/);
  assert.equal(clients.slack.calls.length, 0);
});

test("argument order does not change what was approved", async () => {
  const { hub, clients } = buildHub();
  await hub.indexAll();

  const token = await requestApproval(hub, "slack:post_message", {
    channel: "#general",
    text: "hi",
  });

  const reordered = await hub.execute(
    "slack:post_message",
    { text: "hi", channel: "#general" },
    { approvalToken: token },
  );

  assert.equal(reordered.ok, true);
  assert.equal(clients.slack.calls.length, 1);
});

test("an expired token is rejected", async () => {
  let now = 1_000_000;
  const { hub, clients } = buildHub({
    approvals: { ttlMs: 60_000, now: () => now },
  });
  await hub.indexAll();

  const args = { channel: "#general", text: "hi" };
  const token = await requestApproval(hub, "slack:post_message", args);

  now += 60_001;

  const stale = await hub.execute("slack:post_message", args, { approvalToken: token });
  assert.equal(stale.ok, false);
  assert.match(stale.error ?? "", /Approval rejected/);
  assert.equal(clients.slack.calls.length, 0);
  assert.equal(hub.pendingApprovals(), 0);
});

test("an unknown token is rejected", async () => {
  const { hub, clients } = buildHub();
  await hub.indexAll();

  const result = await hub.execute(
    "slack:post_message",
    { text: "hi" },
    { approvalToken: "not-a-real-token" },
  );

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /unknown, already used, or expired/);
  assert.equal(clients.slack.calls.length, 0);
});

test("auto-approved actions run without a token", async () => {
  const { hub, clients } = buildHub();
  await hub.indexAll();

  const result = await hub.execute("github:create_pull_request", { title: "Add feature" });

  assert.equal(result.ok, true);
  assert.equal(result.approval, undefined);
  assert.equal(clients.github.calls.length, 1);
  assert.equal(hub.history().at(-1)?.approval, undefined);
  assert.equal(hub.pendingApprovals(), 0);
});

test("lowering the auto-approve floor stops gating untrusted servers", async () => {
  const { hub, clients } = buildHub({ policy: { autoApproveAtOrAbove: "untrusted" } });
  await hub.indexAll();

  const result = await hub.execute("slack:post_message", { text: "hi" });
  assert.equal(result.ok, true);
  assert.equal(result.approval, undefined);
  assert.equal(clients.slack.calls.length, 1);
});

test("a deny-listed tool cannot be approved", async () => {
  const clients = buildClients();
  const { factory } = makeFactory(clients);
  const hub = new ActionHub({
    servers: [servers[0]!, { ...servers[1]!, denyTools: ["post_message"] }],
    clientFactory: factory,
  });
  await hub.indexAll();

  const result = await hub.execute("slack:post_message", { text: "hi" });
  assert.equal(result.ok, false);
  // Denied tools never enter the catalog, so there is nothing to approve.
  assert.match(result.error ?? "", /Unknown action/);
  assert.equal(result.approval, undefined);
  assert.equal(hub.pendingApprovals(), 0);
  assert.equal(clients.slack.calls.length, 0);
});

test("the policy denies a deny-listed tool outright, never gating it", () => {
  const policy = new PermissionPolicy({ autoApproveAtOrAbove: "trusted" });
  const action = {
    id: "slack:post_message",
    serverId: "slack",
    name: "post_message",
    kind: "tool" as const,
    trust: "untrusted" as const,
  };

  // Second line of defence behind the index-time filter: even if a deny-list is
  // added after indexing, the action is refused rather than downgraded to a
  // gate the model could then ask the user to wave through.
  const denied = policy.evaluate(action, {
    ...servers[1]!,
    denyTools: ["post_message"],
  });
  assert.equal(denied.allowed, false);
  assert.equal(denied.requiresApproval, false);
  assert.match(denied.reason ?? "", /excluded by the allow\/deny list/);

  // Deny beats allow, so listing the tool in both still denies it.
  const both = policy.evaluate(action, {
    ...servers[1]!,
    allowTools: ["post_message"],
    denyTools: ["post_message"],
  });
  assert.equal(both.allowed, false);
  assert.equal(both.requiresApproval, false);

  const disabled = policy.evaluate(action, { ...servers[1]!, enabled: false });
  assert.equal(disabled.allowed, false);
  assert.equal(disabled.requiresApproval, false);

  // Only a permitted-but-untrusted action is ever gated.
  const gated = policy.evaluate(action, servers[1]!);
  assert.equal(gated.allowed, true);
  assert.equal(gated.requiresApproval, true);
});

test("a blocked server cannot be approved", async () => {
  const clients = buildClients();
  const { factory } = makeFactory(clients);
  const hub = new ActionHub({
    servers: [servers[0]!, { ...servers[1]!, trust: "blocked" }],
    clientFactory: factory,
  });
  await hub.indexAll();

  const result = await hub.execute("slack:post_message", { text: "hi" });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /blocked by policy/);
  assert.equal(result.approval, undefined);
  assert.equal(clients.slack.calls.length, 0);
});

test("a token from one hub is worthless against a denying hub", async () => {
  const permissive = buildHub();
  await permissive.hub.indexAll();
  const args = { channel: "#general", text: "hi" };
  const token = await requestApproval(permissive.hub, "slack:post_message", args);

  const clients = buildClients();
  const { factory } = makeFactory(clients);
  const strict = new ActionHub({
    servers: [servers[0]!, { ...servers[1]!, trust: "blocked" }],
    clientFactory: factory,
  });
  await strict.indexAll();

  // Deny is evaluated before the token is even looked at.
  const result = await strict.execute("slack:post_message", args, { approvalToken: token });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /blocked by policy/);
  assert.equal(clients.slack.calls.length, 0);
});

test("a token is not honoured for a different action", async () => {
  const { hub, clients } = buildHub();
  await hub.indexAll();

  const token = await requestApproval(hub, "slack:post_message", { text: "hi" });

  // github is auto-approved, so the token is simply ignored rather than
  // rejected; the important part is that it grants nothing extra.
  const other = await hub.execute(
    "github:create_pull_request",
    { title: "Add feature" },
    { approvalToken: token },
  );
  assert.equal(other.ok, true);

  // The slack token is still outstanding and still required.
  assert.equal(hub.pendingApprovals(), 1);
  assert.equal(clients.slack.calls.length, 0);
});

test("a gated action with invalid arguments fails without issuing a token", async () => {
  const { hub, clients } = buildHub();
  await hub.indexAll();

  // upload_file requires `path`. The user should never be asked to approve a
  // call that was going to fail anyway, and a bad call must not burn a token.
  const result = await hub.execute("slack:upload_file", {});

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /required property is missing/);
  assert.equal(result.approval, undefined);
  assert.equal(hub.pendingApprovals(), 0);
  assert.equal(clients.slack.calls.length, 0);
});

test("registry binds tokens to action and arguments", () => {
  let now = 0;
  const registry = new ApprovalRegistry({ ttlMs: 1_000, now: () => now });
  const request = registry.issue({
    actionId: "slack:post_message",
    serverId: "slack",
    name: "post_message",
    trust: "untrusted",
    reason: 'Server "slack" is untrusted',
    args: { text: "hi" },
  });

  assert.equal(
    registry.consume(request.approvalToken, "other:action", { text: "hi" }).code,
    "action_mismatch",
  );
  assert.equal(
    registry.consume(request.approvalToken, "slack:post_message", { text: "bye" }).code,
    "arguments_mismatch",
  );
  // Neither mismatch consumed the token.
  assert.equal(registry.size, 1);

  now = 1_001;
  assert.equal(registry.consume(request.approvalToken, "slack:post_message", { text: "hi" }).ok, false);
  assert.equal(registry.size, 0);
});

test("registry evicts rather than growing without bound", () => {
  const registry = new ApprovalRegistry({ maxPending: 2 });
  for (let index = 0; index < 5; index += 1) {
    registry.issue({
      actionId: `slack:tool_${index}`,
      serverId: "slack",
      name: `tool_${index}`,
      trust: "untrusted",
      reason: "untrusted",
      args: { index },
    });
  }
  assert.equal(registry.size, 2);

  registry.clear();
  assert.equal(registry.size, 0);
});

test("argument fingerprints ignore key order but not values", () => {
  assert.equal(
    fingerprintArguments({ a: 1, b: 2 }),
    fingerprintArguments({ b: 2, a: 1 }),
  );
  assert.notEqual(
    fingerprintArguments({ a: 1, b: 2 }),
    fingerprintArguments({ a: 1, b: 3 }),
  );
  assert.notEqual(fingerprintArguments({ a: 1 }), fingerprintArguments({ a: "1" }));
  assert.notEqual(
    fingerprintArguments({ nested: { deep: [1, 2] } }),
    fingerprintArguments({ nested: { deep: [2, 1] } }),
  );
});
