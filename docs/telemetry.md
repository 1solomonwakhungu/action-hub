# Observability and Telemetry

Action Hub core instruments `search`, `load`, `loadBundle`, and `execute` with
OpenTelemetry while keeping a strict zero-runtime-lock-in design. The
instrumentation lives in `packages/core/src/telemetry/index.ts` and the span
bodies in `packages/core/src/action-hub.ts`; `packages/core/test/telemetry.test.ts`
pins the attribute names and values below.

---

## Design principles

1. **Runtime agnostic, zero lock-in**
   `@action-hub/core` depends only on `@opentelemetry/api`. When no
   OpenTelemetry SDK is registered in the host process, every tracing call is
   a no-op. Hosts (the CLI, the MCP server, desktop hosts) own exporter
   configuration, sampling, and resource detection.

2. **Strict privacy and low cardinality**
   Span attributes capture operational health, latency, payload sizes, token
   savings, and error categories. They deliberately omit:
   - tool arguments and invocation parameters
   - tool execution results or outputs
   - full JSON schemas
   - credentials, tokens, approval tokens, or auth headers
   - the free-text query (only its length is recorded)

3. **Safe context propagation**
   HTTP transports propagate W3C Trace Context (`traceparent`, `tracestate`)
   so downstream MCP servers can correlate calls within the active trace.
   Stdio transports are left untouched so nothing can corrupt the JSON-RPC
   framing.

4. **Guaranteed single span termination**
   Spans run inside `withActiveSpan` / `withSyncSpan`, which end the span
   exactly once across every outcome: success, policy denial, approval gate,
   timeout, argument validation failure, and downstream error.

---

## Span names

| Span | Operation |
| --- | --- |
| `action_hub.search` | `ActionHub#search` |
| `action_hub.load` | `ActionHub#load` |
| `action_hub.load_bundle` | `ActionHub#loadBundle` |
| `action_hub.execute` | `ActionHub#execute` |

---

## Semantic attributes

All attributes use the `action_hub.` namespace. The constants are exported as
`ACTION_HUB_ATTRIBUTES` from `@action-hub/core`.

| Attribute | Type | Operations | Description |
| --- | --- | --- | --- |
| `action_hub.operation` | string | all | `search`, `load`, `load_bundle`, or `execute`. |
| `action_hub.status` | string | all | Outcome: `ok`, `approval_required`, `rejected`, `timed_out`, or `error`. |
| `action_hub.action_id` | string | `load`, `execute` | Namespaced action id (e.g. `github:create_pull_request`). |
| `action_hub.server_id` | string | `load`, `execute` | Server id (e.g. `github`). |
| `action_hub.action_name` | string | `load`, `execute` | Upstream tool or skill name. |
| `action_hub.action_kind` | string | `load`, `execute` | `tool` or `skill`. |
| `action_hub.trust` | string | `load`, `execute` | Trust tier of the owning server: `blocked`, `untrusted`, or `trusted`. |
| `action_hub.search.query_length` | int | `search` | Length of the query in characters. The query text itself is never recorded. |
| `action_hub.search.limit` | int | `search` | Result limit applied (default 10). |
| `action_hub.search.include_schema` | bool | `search` | Whether schemas were requested on the hits. |
| `action_hub.search.server_filter` | string[] | `search` | Server ids the search was restricted to, when given. |
| `action_hub.search.min_trust` | string | `search` | Minimum trust tier filter, when given. |
| `action_hub.search.result_count` | int | `search` | Number of hits returned. |
| `action_hub.bundle_id` | string | `load_bundle` | Bundle id. |
| `action_hub.bundle.actions_count` | int | `load_bundle` | Actions in the bundle. |
| `action_hub.bundle.total_eager_tokens` | int | `load_bundle` | Estimated tokens if every schema were resident. |
| `action_hub.bundle.total_lazy_tokens` | int | `load_bundle` | Estimated tokens for the lazy representation. |
| `action_hub.tokens_saved` | int | `load_bundle` | Difference between the two estimates. |
| `action_hub.request.argument_count` | int | `execute` | Top-level keys in the arguments object. |
| `action_hub.request.payload_size_bytes` | int | `execute` | UTF-8 byte length of the serialized arguments. |
| `action_hub.response.payload_size_bytes` | int | `execute` | UTF-8 byte length of the serialized response. |
| `action_hub.execution.status` | string | `execute` | `success`, `approval_required`, `rejected`, `timed_out`, or `failed`. |
| `action_hub.execution.duration_ms` | int | `execute` | End-to-end execution latency. |
| `action_hub.approval.required` | bool | `execute` | True when the policy decision required approval. |
| `action_hub.approval.has_token` | bool | `execute` | True when the call carried an approval token. |
| `action_hub.approval.status` | string | `execute` | `required`, `approved`, or `rejected`, when an approval gate applied. |
| `action_hub.cached` | bool | `execute` | True when the result was served from the idempotent-read cache. |
| `action_hub.error.code` | string | on error | Machine-readable error code (below). |
| `action_hub.error.reason` | string | on error | Policy reason or validation summary. Never contains argument values. |
| `action_hub.error.class` | string | on error | JavaScript error constructor name. |

`action_hub.error.message` is declared in `ACTION_HUB_ATTRIBUTES` but core does
not set it; the error text goes to the span status message instead. Payload
sizes are computed by `safeByteLength`, which serializes the value only to
measure it and never retains or records the content.

---

## Span status and error codes

Spans report standard OpenTelemetry status codes (`OK`, `ERROR`, or `UNSET`).

When an operation fails or is rejected, `action_hub.error.code` is set to one
of (`ActionHubErrorCode` in `telemetry/index.ts`):

- `unknown_action` — the action id is not in the indexed catalog
- `unknown_bundle` — the bundle id is not defined
- `skill_not_executable` — `execute` was called on a skill (skills are loaded, not executed)
- `policy_denied` — denied unconditionally by policy (disabled server, `blocked` tier, deny list)
- `approval_required` — execution paused awaiting a human decision and a single-use approval token
- `approval_rejected` — the supplied approval token was invalid, expired, or bound to different arguments
- `validation_failed` — arguments failed local JSON Schema validation before dispatch
- `timeout` — downstream execution exceeded the server's or the default timeout
- `circuit_breaker_open` — the owning server's circuit is open; the call failed fast
- `downstream_error` — the downstream MCP server returned or threw an error

`internal_error` is declared in the type for hosts that wrap the hub, but core
does not currently emit it.

---

## Context propagation

For remote MCP servers connected over HTTP, Action Hub injects the active W3C
trace context into outgoing requests:

```
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
tracestate: congo=t61rcWkgMzE
```

This works alongside OAuth 2.0 authentication headers. Stdio transports carry
no HTTP headers, so nothing is injected there.

---

## Host configuration examples

Because `@action-hub/core` uses only the OpenTelemetry API, hosts can wire any
OpenTelemetry-compatible SDK or exporter.

### Node.js host with an OTLP exporter

```ts
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { ActionHub } from "@action-hub/core";

// Initialize the OpenTelemetry SDK before creating the hub.
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

// ActionHub picks up the global TracerProvider.
const hub = new ActionHub({
  servers: [
    { id: "github", transport: { type: "stdio", command: "gh-mcp" } },
  ],
});
await hub.indexAll();
```

### Explicit tracer (testing, custom routing)

```ts
import { trace } from "@opentelemetry/api";
import { ActionHub } from "@action-hub/core";

const customTracer = trace.getTracer("my-application", "1.0.0");

const hub = new ActionHub({
  servers: [...],
  tracer: customTracer,
});
```

`ActionHubOptions.telemetry` also accepts `{ tracerProvider, tracerName,
tracerVersion, enabled }`; `enabled: false` swaps in a no-op tracer regardless
of the global provider.
