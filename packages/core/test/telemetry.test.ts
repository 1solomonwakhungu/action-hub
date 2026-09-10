import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ActionHub,
  ACTION_HUB_ATTRIBUTES,
  SpanStatusCode,
  trace,
  context,
  propagation,
} from "../dist/index.js";
import type {
  ServerConfig,
  Tracer,
  Span,
  SpanOptions,
  SpanContext,
  Attributes,
  AttributeValue,
  SpanStatus,
  Exception,
  TextMapPropagator,
  TextMapSetter,
} from "../dist/index.js";
import { FakeClient, makeFactory } from "./fakes.ts";

interface RecordedSpan {
  name: string;
  options?: SpanOptions;
  attributes: Record<string, AttributeValue>;
  status: SpanStatus;
  exceptions: Exception[];
  ended: boolean;
  endCount: number;
  spanContext: SpanContext;
}

class InMemoryTestTracer implements Tracer {
  readonly spans: RecordedSpan[] = [];

  startSpan(name: string, options?: SpanOptions, parentContext = context.active()): Span {
    const parentSpan = trace.getSpan(parentContext);
    const traceId = parentSpan?.spanContext().traceId ?? "1234567890abcdef1234567890abcdef";
    const spanId = `span-${this.spans.length + 1}`;

    const recorded: RecordedSpan = {
      name,
      options,
      attributes: { ...(options?.attributes ?? {}) },
      status: { code: SpanStatusCode.UNSET },
      exceptions: [],
      ended: false,
      endCount: 0,
      spanContext: {
        traceId,
        spanId,
        traceFlags: 1,
      },
    };

    this.spans.push(recorded);

    const spanObj: Span = {
      spanContext: () => recorded.spanContext,
      setAttribute: (key: string, value: AttributeValue) => {
        recorded.attributes[key] = value;
        return spanObj;
      },
      setAttributes: (attrs: Attributes) => {
        for (const [k, v] of Object.entries(attrs)) {
          if (v !== undefined) recorded.attributes[k] = v;
        }
        return spanObj;
      },
      addEvent: () => spanObj,
      addLink: () => spanObj,
      addLinks: () => spanObj,
      setStatus: (status: SpanStatus) => {
        recorded.status = status;
        return spanObj;
      },
      updateName: (newName: string) => {
        recorded.name = newName;
        return spanObj;
      },
      end: () => {
        recorded.ended = true;
        recorded.endCount++;
      },
      isRecording: () => true,
      recordException: (exception: Exception) => {
        recorded.exceptions.push(exception);
      },
    };

    return spanObj;
  }

  startActiveSpan<T>(name: string, fn: (span: Span) => T): T;
  startActiveSpan<T>(name: string, options: SpanOptions, fn: (span: Span) => T): T;
  startActiveSpan<T>(name: string, options: SpanOptions, ctx: unknown, fn: (span: Span) => T): T;
  startActiveSpan<T>(...args: unknown[]): T {
    const name = args[0] as string;
    let options: SpanOptions | undefined;
    let fn: (span: Span) => T;
    if (typeof args[1] === "function") {
      fn = args[1] as (span: Span) => T;
    } else {
      options = args[1] as SpanOptions;
      fn = (typeof args[2] === "function" ? args[2] : args[3]) as (span: Span) => T;
    }
    const span = this.startSpan(name, options);
    const ctx = trace.setSpan(context.active(), span);
    return context.with(ctx, () => {
      try {
        return fn(span);
      } finally {
        span.end();
      }
    });
  }
}

const servers: ServerConfig[] = [
  { id: "github", transport: { type: "stdio", command: "gh-mcp" }, trust: "trusted" },
  { id: "slack", transport: { type: "stdio", command: "slack-mcp" }, trust: "untrusted" },
];

function buildClients() {
  return {
    github: new FakeClient([
      {
        name: "create_pull_request",
        description: "Open a new pull request.\nSupports draft mode.",
        inputSchema: {
          type: "object",
          properties: { title: { type: "string" }, draft: { type: "boolean" } },
          required: ["title"],
        },
      },
      { name: "list_issues", description: "List repository issues", inputSchema: { type: "object" } },
      { name: "slow_tool", description: "Slow tool for timeout tests", inputSchema: { type: "object" } },
    ], (name) => {
      if (name === "slow_tool") {
        return new Promise((resolve) => setTimeout(() => resolve("done"), 500));
      }
      return `ok:${name}`;
    }),
    slack: new FakeClient([
      { name: "post_message", description: "Post a Slack message", inputSchema: { type: "object" } },
      { name: "failing_tool", description: "Fails downstream", inputSchema: { type: "object" } },
    ], (name) => {
      if (name === "failing_tool") {
        throw new Error("Slack API connection dropped");
      }
      return `ok:${name}`;
    }),
  };
}

function buildTestHub(tracer: InMemoryTestTracer, overrides: Partial<ConstructorParameters<typeof ActionHub>[0]> = {}) {
  const clients = buildClients();
  const { factory, activations } = makeFactory(clients);
  const testServers: ServerConfig[] = servers.map((s) => ({ ...s, transport: { ...s.transport } as ServerConfig["transport"] }));
  const hub = new ActionHub({
    servers: testServers,
    clientFactory: factory,
    tracer,
    defaultTimeoutMs: 50,
    ...overrides,
  });
  return { hub, clients, activations };
}

test("no-op default: works normally without configured tracer or SDK", async () => {
  const clients = buildClients();
  const { factory } = makeFactory(clients);
  const testServers: ServerConfig[] = servers.map((s) => ({ ...s, transport: { ...s.transport } as ServerConfig["transport"] }));
  const hub = new ActionHub({ servers: testServers, clientFactory: factory });
  await hub.indexAll();

  const hits = await hub.search("pull request");
  assert.ok(hits.length > 0);

  const loaded = hub.load("github:create_pull_request");
  assert.equal(loaded.id, "github:create_pull_request");

  const result = await hub.execute("github:create_pull_request", { title: "Fix bug" });
  assert.equal(result.ok, true);
});

test("instrumentation: search records span with query length, limit, and result count", async () => {
  const tracer = new InMemoryTestTracer();
  const { hub } = buildTestHub(tracer);
  await hub.indexAll();

  tracer.spans.length = 0; // Clear index-time spans if any
  const hits = await hub.search("pull request", { limit: 5 });
  assert.ok(hits.length > 0);

  const span = tracer.spans.find((s) => s.name === "action_hub.search");
  assert.ok(span, "search span should be created");
  assert.equal(span.ended, true);
  assert.equal(span.endCount, 1);
  assert.equal(span.status.code, SpanStatusCode.OK);

  assert.equal(span.attributes[ACTION_HUB_ATTRIBUTES.OPERATION], "search");
  assert.equal(span.attributes[ACTION_HUB_ATTRIBUTES.SEARCH_QUERY_LENGTH], "pull request".length);
  assert.equal(span.attributes[ACTION_HUB_ATTRIBUTES.SEARCH_LIMIT], 5);
  assert.equal(span.attributes[ACTION_HUB_ATTRIBUTES.SEARCH_RESULT_COUNT], hits.length);
  assert.equal(span.attributes[ACTION_HUB_ATTRIBUTES.STATUS], "ok");
});

test("instrumentation: load records action metadata and handles unknown action error", async () => {
  const tracer = new InMemoryTestTracer();
  const { hub } = buildTestHub(tracer);
  await hub.indexAll();

  // Successful load
  tracer.spans.length = 0;
  const loaded = hub.load("github:create_pull_request");
  assert.equal(loaded.id, "github:create_pull_request");

  const loadSpan = tracer.spans.find((s) => s.name === "action_hub.load");
  assert.ok(loadSpan);
  assert.equal(loadSpan.ended, true);
  assert.equal(loadSpan.endCount, 1);
  assert.equal(loadSpan.status.code, SpanStatusCode.OK);
  assert.equal(loadSpan.attributes[ACTION_HUB_ATTRIBUTES.ACTION_ID], "github:create_pull_request");
  assert.equal(loadSpan.attributes[ACTION_HUB_ATTRIBUTES.SERVER_ID], "github");
  assert.equal(loadSpan.attributes[ACTION_HUB_ATTRIBUTES.ACTION_NAME], "create_pull_request");
  assert.equal(loadSpan.attributes[ACTION_HUB_ATTRIBUTES.TRUST], "trusted");
  assert.equal(loadSpan.attributes[ACTION_HUB_ATTRIBUTES.STATUS], "ok");

  // Unknown action load
  tracer.spans.length = 0;
  assert.throws(() => hub.load("unknown:tool"), /Unknown action/);
  const errorSpan = tracer.spans.find((s) => s.name === "action_hub.load");
  assert.ok(errorSpan);
  assert.equal(errorSpan.ended, true);
  assert.equal(errorSpan.endCount, 1);
  assert.equal(errorSpan.status.code, SpanStatusCode.ERROR);
  assert.equal(errorSpan.attributes[ACTION_HUB_ATTRIBUTES.STATUS], "error");
  assert.equal(errorSpan.attributes[ACTION_HUB_ATTRIBUTES.ERROR_CODE], "unknown_action");
});

test("instrumentation: loadBundle records token savings and action count", async () => {
  const tracer = new InMemoryTestTracer();
  const bundle = {
    id: "git-bundle",
    displayName: "Git Operations",
    actionIds: ["github:create_pull_request", "github:list_issues"],
  };
  const { hub } = buildTestHub(tracer, { bundles: [bundle] });
  await hub.indexAll();

  tracer.spans.length = 0;
  const loaded = hub.loadBundle("git-bundle");
  assert.equal(loaded.actions.length, 2);

  const bundleSpan = tracer.spans.find((s) => s.name === "action_hub.load_bundle");
  assert.ok(bundleSpan);
  assert.equal(bundleSpan.ended, true);
  assert.equal(bundleSpan.endCount, 1);
  assert.equal(bundleSpan.status.code, SpanStatusCode.OK);
  assert.equal(bundleSpan.attributes[ACTION_HUB_ATTRIBUTES.BUNDLE_ID], "git-bundle");
  assert.equal(bundleSpan.attributes[ACTION_HUB_ATTRIBUTES.BUNDLE_ACTIONS_COUNT], 2);
  assert.ok(typeof bundleSpan.attributes[ACTION_HUB_ATTRIBUTES.TOKENS_SAVED] === "number");
  assert.equal(bundleSpan.attributes[ACTION_HUB_ATTRIBUTES.STATUS], "ok");
});

test("instrumentation: execute - success outcome sets status ok and records safe payload size", async () => {
  const tracer = new InMemoryTestTracer();
  const { hub } = buildTestHub(tracer);
  await hub.indexAll();

  tracer.spans.length = 0;
  const result = await hub.execute("github:create_pull_request", { title: "Telemetry Support" });
  assert.equal(result.ok, true);

  const span = tracer.spans.find((s) => s.name === "action_hub.execute");
  assert.ok(span);
  assert.equal(span.ended, true);
  assert.equal(span.endCount, 1);
  assert.equal(span.status.code, SpanStatusCode.OK);

  assert.equal(span.attributes[ACTION_HUB_ATTRIBUTES.EXECUTION_STATUS], "success");
  assert.equal(span.attributes[ACTION_HUB_ATTRIBUTES.STATUS], "ok");
  assert.equal(span.attributes[ACTION_HUB_ATTRIBUTES.ACTION_ID], "github:create_pull_request");
  assert.equal(span.attributes[ACTION_HUB_ATTRIBUTES.SERVER_ID], "github");
  assert.equal(span.attributes[ACTION_HUB_ATTRIBUTES.TRUST], "trusted");
  assert.equal(span.attributes[ACTION_HUB_ATTRIBUTES.REQUEST_ARGUMENT_COUNT], 1);
  assert.ok(Number(span.attributes[ACTION_HUB_ATTRIBUTES.REQUEST_PAYLOAD_SIZE_BYTES]) > 0);
  assert.ok(Number(span.attributes[ACTION_HUB_ATTRIBUTES.RESPONSE_PAYLOAD_SIZE_BYTES]) > 0);
  assert.ok(typeof span.attributes[ACTION_HUB_ATTRIBUTES.EXECUTION_DURATION_MS] === "number");

  // Verify sensitive data is NOT present in attributes
  assert.equal("title" in span.attributes, false);
  assert.equal("args" in span.attributes, false);
  assert.equal("Telemetry Support" in Object.values(span.attributes), false);
});

test("instrumentation: execute - policy rejection outcome sets rejected status and reason", async () => {
  const tracer = new InMemoryTestTracer();
  const { hub } = buildTestHub(tracer);
  await hub.indexAll();

  // Disable server post-indexing to test policy rejection
  const slackConfig = hub.connections.getConfig("slack");
  if (slackConfig) (slackConfig as { enabled?: boolean }).enabled = false;

  tracer.spans.length = 0;
  const result = await hub.execute("slack:post_message", { message: "hello" });
  assert.equal(result.ok, false);

  const span = tracer.spans.find((s) => s.name === "action_hub.execute");
  assert.ok(span);
  assert.equal(span.ended, true);
  assert.equal(span.endCount, 1);
  assert.equal(span.status.code, SpanStatusCode.ERROR);
  assert.equal(span.attributes[ACTION_HUB_ATTRIBUTES.EXECUTION_STATUS], "rejected");
  assert.equal(span.attributes[ACTION_HUB_ATTRIBUTES.STATUS], "rejected");
  assert.equal(span.attributes[ACTION_HUB_ATTRIBUTES.ERROR_CODE], "policy_denied");
  assert.ok(typeof span.attributes[ACTION_HUB_ATTRIBUTES.ERROR_REASON] === "string");
});

test("instrumentation: execute - approval-required outcome sets approval attributes", async () => {
  const tracer = new InMemoryTestTracer();
  // Untrusted requires approval by default policy
  const { hub } = buildTestHub(tracer);
  await hub.indexAll();

  // First call: approval required
  tracer.spans.length = 0;
  const result1 = await hub.execute("slack:post_message", { channel: "dev" });
  assert.equal(result1.ok, false);
  assert.ok(result1.approval?.approvalToken);

  const span1 = tracer.spans.find((s) => s.name === "action_hub.execute");
  assert.ok(span1);
  assert.equal(span1.ended, true);
  assert.equal(span1.endCount, 1);
  assert.equal(span1.attributes[ACTION_HUB_ATTRIBUTES.EXECUTION_STATUS], "approval_required");
  assert.equal(span1.attributes[ACTION_HUB_ATTRIBUTES.STATUS], "approval_required");
  assert.equal(span1.attributes[ACTION_HUB_ATTRIBUTES.APPROVAL_STATUS], "required");
  assert.equal(span1.attributes[ACTION_HUB_ATTRIBUTES.APPROVAL_REQUIRED], true);
  assert.equal(span1.attributes[ACTION_HUB_ATTRIBUTES.ERROR_CODE], "approval_required");

  // Second call with approval token: approved execution succeeds
  tracer.spans.length = 0;
  const result2 = await hub.execute(
    "slack:post_message",
    { channel: "dev" },
    { approvalToken: result1.approval.approvalToken },
  );
  assert.equal(result2.ok, true);

  const span2 = tracer.spans.find((s) => s.name === "action_hub.execute");
  assert.ok(span2);
  assert.equal(span2.ended, true);
  assert.equal(span2.endCount, 1);
  assert.equal(span2.status.code, SpanStatusCode.OK);
  assert.equal(span2.attributes[ACTION_HUB_ATTRIBUTES.EXECUTION_STATUS], "success");
  assert.equal(span2.attributes[ACTION_HUB_ATTRIBUTES.APPROVAL_STATUS], "approved");
  assert.equal(span2.attributes[ACTION_HUB_ATTRIBUTES.APPROVAL_HAS_TOKEN], true);

  // Third call with already consumed token: approval rejected
  tracer.spans.length = 0;
  const result3 = await hub.execute(
    "slack:post_message",
    { channel: "dev" },
    { approvalToken: result1.approval.approvalToken },
  );
  assert.equal(result3.ok, false);

  const span3 = tracer.spans.find((s) => s.name === "action_hub.execute");
  assert.ok(span3);
  assert.equal(span3.ended, true);
  assert.equal(span3.endCount, 1);
  assert.equal(span3.attributes[ACTION_HUB_ATTRIBUTES.EXECUTION_STATUS], "rejected");
  assert.equal(span3.attributes[ACTION_HUB_ATTRIBUTES.APPROVAL_STATUS], "rejected");
  assert.equal(span3.attributes[ACTION_HUB_ATTRIBUTES.ERROR_CODE], "approval_rejected");
});

test("instrumentation: execute - timeout outcome sets timed_out status and error code", async () => {
  const tracer = new InMemoryTestTracer();
  const { hub } = buildTestHub(tracer, { defaultTimeoutMs: 20 });
  await hub.indexAll();

  tracer.spans.length = 0;
  const result = await hub.execute("github:slow_tool", {});
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /timed out/);

  const span = tracer.spans.find((s) => s.name === "action_hub.execute");
  assert.ok(span);
  assert.equal(span.ended, true);
  assert.equal(span.endCount, 1);
  assert.equal(span.status.code, SpanStatusCode.ERROR);
  assert.equal(span.attributes[ACTION_HUB_ATTRIBUTES.EXECUTION_STATUS], "timed_out");
  assert.equal(span.attributes[ACTION_HUB_ATTRIBUTES.STATUS], "timed_out");
  assert.equal(span.attributes[ACTION_HUB_ATTRIBUTES.ERROR_CODE], "timeout");
});

test("instrumentation: execute - downstream failure outcome records error class and exception", async () => {
  const tracer = new InMemoryTestTracer();
  // Allow untrusted without approval so it reaches execution
  const { hub } = buildTestHub(tracer, {
    policy: { autoApproveAtOrAbove: "untrusted" },
  });
  await hub.indexAll();

  tracer.spans.length = 0;
  const result = await hub.execute("slack:failing_tool", {});
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /Slack API connection dropped/);

  const span = tracer.spans.find((s) => s.name === "action_hub.execute");
  assert.ok(span);
  assert.equal(span.ended, true);
  assert.equal(span.endCount, 1);
  assert.equal(span.status.code, SpanStatusCode.ERROR);
  assert.equal(span.attributes[ACTION_HUB_ATTRIBUTES.EXECUTION_STATUS], "failed");
  assert.equal(span.attributes[ACTION_HUB_ATTRIBUTES.STATUS], "error");
  assert.equal(span.attributes[ACTION_HUB_ATTRIBUTES.ERROR_CODE], "downstream_error");
  assert.equal(span.attributes[ACTION_HUB_ATTRIBUTES.ERROR_CLASS], "Error");
  assert.equal(span.exceptions.length, 1);
});

test("instrumentation: execute - invalid arguments fails validation before downstream call", async () => {
  const tracer = new InMemoryTestTracer();
  const { hub } = buildTestHub(tracer);
  await hub.indexAll();

  tracer.spans.length = 0;
  // create_pull_request requires "title"
  const result = await hub.execute("github:create_pull_request", {});
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /Invalid arguments/);

  const span = tracer.spans.find((s) => s.name === "action_hub.execute");
  assert.ok(span);
  assert.equal(span.ended, true);
  assert.equal(span.endCount, 1);
  assert.equal(span.status.code, SpanStatusCode.ERROR);
  assert.equal(span.attributes[ACTION_HUB_ATTRIBUTES.EXECUTION_STATUS], "failed");
  assert.equal(span.attributes[ACTION_HUB_ATTRIBUTES.ERROR_CODE], "validation_failed");
});

test("trace propagation: propagates active trace context to downstream call options", async () => {
  const tracer = new InMemoryTestTracer();
  const { hub, clients } = buildTestHub(tracer);
  await hub.indexAll();

  // Configure a test propagator in OpenTelemetry propagation API
  const testPropagator: TextMapPropagator = {
    inject(ctx, carrier, setter: TextMapSetter) {
      const currentSpan = trace.getSpan(ctx);
      if (currentSpan) {
        const sc = currentSpan.spanContext();
        setter.set(carrier, "traceparent", `00-${sc.traceId}-${sc.spanId}-01`);
        setter.set(carrier, "x-action-hub-test", "propagated");
      }
    },
    extract(ctx) {
      return ctx;
    },
    fields() {
      return ["traceparent", "x-action-hub-test"];
    },
  };
  propagation.setGlobalPropagator(testPropagator);

  const result = await hub.execute("github:create_pull_request", { title: "Trace propagation" });
  assert.equal(result.ok, true);

  const client = clients.github;
  const lastCall = client.calls[client.calls.length - 1];
  assert.ok(lastCall);
  assert.ok(lastCall.options?.headers);
  assert.match(lastCall.options.headers["traceparent"] ?? "", /^00-.*-01$/);
  assert.equal(lastCall.options.headers["x-action-hub-test"], "propagated");
});
