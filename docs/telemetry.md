# Observability and Telemetry

Action Hub incorporates OpenTelemetry instrumentation across its core operations (`search`, `load`, `loadBundle`, and `execute`) while maintaining a strict zero runtime lock-in design.

---

## Design Principles

1. **Runtime Agnostic & Zero Lock-in**  
   `@action-hub/core` depends exclusively on `@opentelemetry/api`. When no OpenTelemetry SDK is initialized in the host application, all tracing calls are zero-overhead no-ops. Host applications (CLI, Copilot plugin server, desktop hosts) retain complete ownership over exporter configuration, sampling rules, and resource detectors.

2. **Strict Privacy & Low Cardinality**  
   Span attributes capture operational health, latency, payload sizes, token savings, and error categories. They deliberately omit:
   - Tool arguments and invocation parameters
   - Tool execution results or outputs
   - Full JSON schemas
   - Credentials, tokens, or auth headers
   - Unbounded free-text queries

3. **Safe Context Propagation**  
   Out-of-process HTTP/SSE transports propagate W3C Trace Context (`traceparent` and `tracestate`) so downstream MCP servers can correlate calls within the active trace. Local stdio transports remain untouched to prevent corrupting stdio JSON-RPC framing.

4. **Guaranteed Single Span Termination**  
   Spans are wrapped with idempotent lifecycle managers (`withActiveSpan`, `withSyncSpan`) ensuring every span closes exactly once across all outcomes: success, policy denial, approval gates, timeouts, argument validation failures, and downstream errors.

---

## Semantic Attributes

All attributes use the `action_hub.` namespace:

| Attribute Name | Type | Operations | Description |
| --- | --- | --- | --- |
| `action_hub.operation` | string | all | Operation name: `search`, `load`, `load_bundle`, or `execute`. |
| `action_hub.status` | string | all | Outcome status: `ok`, `approval_required`, `rejected`, or `error`. |
| `action_hub.action.id` | string | `load`, `execute` | Namespaced action identifier (e.g. `github:create_pull_request`). |
| `action_hub.server.id` | string | `load`, `execute` | Server identifier (e.g. `github`, `slack`). |
| `action_hub.action.name` | string | `load`, `execute` | Tool or action name. |
| `action_hub.action.kind` | string | `load`, `execute` | Action kind: `tool` or `skill`. |
| `action_hub.trust` | string | `load`, `execute` | Server trust tier: `trusted`, `standard`, or `untrusted`. |
| `action_hub.search.query_length` | int | `search` | Length of search query in characters. |
| `action_hub.search.result_count` | int | `search` | Number of matching actions returned. |
| `action_hub.search.limit` | int | `search` | Limit applied to search results. |
| `action_hub.search.has_threshold` | bool | `search` | Whether a minimum score threshold was provided. |
| `action_hub.bundle.id` | string | `load_bundle` | Bundle identifier. |
| `action_hub.bundle.actions_count` | int | `load_bundle` | Number of actions bundled. |
| `action_hub.bundle.total_eager_tokens` | int | `load_bundle` | Estimated tokens if all schemas were resident. |
| `action_hub.bundle.total_lazy_tokens` | int | `load_bundle` | Tokens consumed via Action Hub lazy representation. |
| `action_hub.tokens_saved` | int | `load_bundle` | Net context tokens saved by lazy loading. |
| `action_hub.request.argument_count` | int | `execute` | Number of top-level keys in the arguments object. |
| `action_hub.request.payload_size_bytes` | int | `execute` | Estimated UTF-8 byte length of arguments. |
| `action_hub.response.payload_size_bytes` | int | `execute` | Estimated UTF-8 byte length of response. |
| `action_hub.execution.status` | string | `execute` | Execution state: `success`, `approval_required`, `rejected`, `timed_out`, or `failed`. |
| `action_hub.execution.duration_ms` | int | `execute` | End-to-end execution latency in milliseconds. |
| `action_hub.approval.status` | string | `execute` | Approval status: `none`, `required`, `approved`, or `rejected`. |
| `action_hub.approval.required` | bool | `execute` | True if the action required interactive approval. |
| `action_hub.approval.has_token` | bool | `execute` | True if the execution carried an approval token. |
| `action_hub.error.code` | string | on error | Machine-readable error code (see below). |
| `action_hub.error.reason` | string | on error | Diagnostic description of failure or policy rejection. |
| `action_hub.error.class` | string | on error | JavaScript error constructor name. |

---

## Span Status & Error Codes

Spans report standard OpenTelemetry status codes (`SpanStatusCode.OK`, `SpanStatusCode.ERROR`, or `SpanStatusCode.UNSET`).

When an operation fails or is rejected, `action_hub.error.code` is set to one of the following:

- `unknown_action` — The requested action ID is not present in the indexed catalog.
- `unknown_bundle` — The requested capability bundle ID is not defined.
- `skill_not_executable` — Attempted to execute a skill directly (skills must be loaded, not executed).
- `policy_denied` — Denied unconditionally by policy (e.g. disabled server or untrusted policy).
- `approval_required` — Execution paused awaiting human confirmation and single-use approval token.
- `approval_rejected` — Invalid, expired, or mismatched approval token provided.
- `validation_failed` — Arguments failed local JSON Schema validation prior to dispatch.
- `timeout` — Downstream execution exceeded configured server or default timeout.
- `downstream_error` — Downstream MCP server threw an unhandled error during tool execution.

---

## Context Propagation

For remote MCP servers connected over HTTP/SSE transports, Action Hub injects the active W3C trace context headers into outgoing HTTP requests:

```
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
tracestate: congo=t61rcWkgMzE
```

This works transparently alongside OAuth 2.0 authentication headers. Local stdio transports do not transmit HTTP headers, preserving stdout/stdin integrity for JSON-RPC framing.

---

## Host Configuration Examples

Because `@action-hub/core` uses the OpenTelemetry API, hosts can configure any OpenTelemetry-compatible SDK or exporter.

### Example: Node.js Host with OTLP Exporter

```ts
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { ActionHub } from "@action-hub/core";

// Initialize OpenTelemetry SDK before creating ActionHub
const sdk = new NodeSDK({
  resource: new Resource({
    [ATTR_SERVICE_NAME]: "my-agent-host",
    [ATTR_SERVICE_VERSION]: "1.0.0",
  }),
  traceExporter: new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318/v1/traces",
  }),
});

sdk.start();

// ActionHub automatically detects and uses the active TracerProvider
const hub = new ActionHub({
  servers: [
    { id: "github", transport: { type: "stdio", command: "gh-mcp" } },
  ],
});
await hub.indexAll();
```

### Example: Explicit Injected Tracer (Testing / Custom Routing)

```ts
import { trace } from "@opentelemetry/api";
import { ActionHub } from "@action-hub/core";

const customTracer = trace.getTracer("my-application", "1.0.0");

const hub = new ActionHub({
  servers: [...],
  tracer: customTracer,
});
```
