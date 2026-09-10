import {
  trace,
  context,
  propagation,
  SpanStatusCode,
  type Tracer,
  type TracerProvider,
  type Span,
  type SpanOptions,
} from "@opentelemetry/api";

export { SpanStatusCode, trace, context, propagation };
export type { Tracer, TracerProvider, Span, SpanOptions };

/**
 * Standard semantic attributes for Action Hub OpenTelemetry spans.
 *
 * All attributes are low-cardinality and safe. Values such as tool arguments,
 * JSON schemas, credentials, approval tokens, and raw output content are
 * strictly omitted to prevent context leaks and unbounded cardinality.
 */
export const ACTION_HUB_ATTRIBUTES = {
  // Operation & Entity
  OPERATION: "action_hub.operation",
  ACTION_ID: "action_hub.action_id",
  SERVER_ID: "action_hub.server_id",
  ACTION_NAME: "action_hub.action_name",
  ACTION_KIND: "action_hub.action_kind",
  TRUST: "action_hub.trust",
  STATUS: "action_hub.status",

  // Search
  SEARCH_QUERY_LENGTH: "action_hub.search.query_length",
  SEARCH_LIMIT: "action_hub.search.limit",
  SEARCH_INCLUDE_SCHEMA: "action_hub.search.include_schema",
  SEARCH_MIN_TRUST: "action_hub.search.min_trust",
  SEARCH_SERVER_FILTER: "action_hub.search.server_filter",
  SEARCH_RESULT_COUNT: "action_hub.search.result_count",

  // Bundles & Tokens
  BUNDLE_ID: "action_hub.bundle_id",
  BUNDLE_ACTIONS_COUNT: "action_hub.bundle.actions_count",
  BUNDLE_TOTAL_EAGER_TOKENS: "action_hub.bundle.total_eager_tokens",
  BUNDLE_TOTAL_LAZY_TOKENS: "action_hub.bundle.total_lazy_tokens",
  TOKENS_SAVED: "action_hub.tokens_saved",

  // Request & Response Payload Metrics (size in bytes, argument counts; never content)
  REQUEST_ARGUMENT_COUNT: "action_hub.request.argument_count",
  REQUEST_PAYLOAD_SIZE_BYTES: "action_hub.request.payload_size_bytes",
  RESPONSE_PAYLOAD_SIZE_BYTES: "action_hub.response.payload_size_bytes",

  // Execution
  EXECUTION_STATUS: "action_hub.execution.status",
  EXECUTION_DURATION_MS: "action_hub.execution.duration_ms",

  // Approvals & Policy
  APPROVAL_HAS_TOKEN: "action_hub.approval.has_token",
  APPROVAL_STATUS: "action_hub.approval.status",
  APPROVAL_REQUIRED: "action_hub.approval.required",

  // Errors & Rejections
  ERROR_CODE: "action_hub.error.code",
  ERROR_CLASS: "action_hub.error.class",
  ERROR_MESSAGE: "action_hub.error.message",
  ERROR_REASON: "action_hub.error.reason",
} as const;

export type ActionHubAttributeKey =
  (typeof ACTION_HUB_ATTRIBUTES)[keyof typeof ACTION_HUB_ATTRIBUTES];

/**
 * Execution outcome classification.
 */
export type ExecutionStatus =
  | "success"
  | "rejected"
  | "timed_out"
  | "approval_required"
  | "failed";

/**
 * Low-cardinality error codes for Action Hub operations.
 */
export type ActionHubErrorCode =
  | "unknown_action"
  | "unknown_bundle"
  | "skill_not_executable"
  | "policy_denied"
  | "validation_failed"
  | "approval_required"
  | "approval_rejected"
  | "timeout"
  | "circuit_breaker_open"
  | "downstream_error"
  | "internal_error";

export interface ActionHubTelemetryOptions {
  /**
   * Explicit Tracer instance to use for Action Hub instrumentation.
   */
  tracer?: Tracer;
  /**
   * Explicit TracerProvider to resolve the tracer from.
   */
  tracerProvider?: TracerProvider;
  /**
   * Instrumentation name passed to getTracer(). Defaults to "@action-hub/core".
   */
  tracerName?: string;
  /**
   * Instrumentation version passed to getTracer(). Defaults to "0.1.0".
   */
  tracerVersion?: string;
  /**
   * When false, disables tracing and uses a no-op tracer. Defaults to true.
   */
  enabled?: boolean;
}

/**
 * Safely computes the UTF-8 byte length of a value when serialized to JSON,
 * without throwing or retaining payload contents.
 */
export function safeByteLength(value: unknown): number {
  if (value === undefined || value === null) return 0;
  try {
    const json = typeof value === "string" ? value : JSON.stringify(value);
    return Buffer.byteLength(json, "utf8");
  } catch {
    return 0;
  }
}

/**
 * Manages OpenTelemetry spans and context propagation for Action Hub.
 *
 * Designed to keep packages/core runtime-agnostic. Defaults to OpenTelemetry's
 * global API tracer (which is a no-op unless an SDK is registered by the host).
 */
export class ActionHubTelemetry {
  readonly tracer: Tracer;
  readonly enabled: boolean;

  constructor(options?: ActionHubTelemetryOptions, directTracer?: Tracer) {
    if (directTracer) {
      this.tracer = directTracer;
      this.enabled = true;
      return;
    }

    if (options?.enabled === false) {
      this.tracer = trace.getTracer("@action-hub/core-noop");
      this.enabled = false;
      return;
    }

    if (options?.tracer) {
      this.tracer = options.tracer;
      this.enabled = true;
      return;
    }

    const name = options?.tracerName ?? "@action-hub/core";
    const version = options?.tracerVersion ?? "0.1.0";

    if (options?.tracerProvider) {
      this.tracer = options.tracerProvider.getTracer(name, version);
      this.enabled = true;
      return;
    }

    // Default: use the global OpenTelemetry API tracer. If no SDK/exporter is
    // configured by the host application, this returns a NoopTracer.
    this.tracer = trace.getTracer(name, version);
    this.enabled = true;
  }

  /**
   * Runs an asynchronous operation within an active OpenTelemetry span.
   * Guarantees the span is closed exactly once in the finally block.
   */
  async withActiveSpan<T>(
    name: string,
    options: SpanOptions,
    fn: (span: Span) => Promise<T>,
  ): Promise<T> {
    const span = this.tracer.startSpan(name, options);
    const ctx = trace.setSpan(context.active(), span);
    let ended = false;
    const end = () => {
      if (!ended) {
        ended = true;
        span.end();
      }
    };

    try {
      return await context.with(ctx, () => fn(span));
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      end();
    }
  }

  /**
   * Runs a synchronous operation within an active OpenTelemetry span.
   * Guarantees the span is closed exactly once in the finally block.
   */
  withSyncSpan<T>(
    name: string,
    options: SpanOptions,
    fn: (span: Span) => T,
  ): T {
    const span = this.tracer.startSpan(name, options);
    const ctx = trace.setSpan(context.active(), span);
    let ended = false;
    const end = () => {
      if (!ended) {
        ended = true;
        span.end();
      }
    };

    try {
      return context.with(ctx, () => fn(span));
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      end();
    }
  }
}
