// Holds an action's finished spans until it saves them to the `spans` table.
//
// The exporter can't write to the database itself: it has no ctx. So it
// keeps each span tagged with a thread, and the action that made them takes
// its thread's spans in its `finally` (see `saveTelemetry` in `spans.ts`).
import type { ExportResult } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { Infer } from "convex/values";
import type { vSpan } from "./tables";

/** Spans held at most: an action that died before its `finally` leaves some. */
const CAPACITY = 2000;
/** `ExportResultCode.SUCCESS`, without importing the enum at runtime. */
const SUCCESS = 0;

export class SpanBuffer implements SpanExporter {
  private held: ReadableSpan[] = [];

  export(spans: ReadableSpan[], done: (result: ExportResult) => void) {
    // A span with no thread has no action to take it.
    this.held.push(...spans.filter((span) => threadOf(span) !== undefined));
    this.held = this.held.slice(-CAPACITY);
    done({ code: SUCCESS });
  }

  /** Removes and returns the spans held for this thread. */
  take(threadId: string): ReadableSpan[] {
    const taken = this.held.filter((span) => threadOf(span) === threadId);
    this.held = this.held.filter((span) => threadOf(span) !== threadId);
    return taken;
  }

  async shutdown() {
    this.held = [];
  }

  async forceFlush() {}
}

export const spanBuffer = new SpanBuffer();

function threadOf(span: ReadableSpan): string | undefined {
  const threadId = span.attributes["convex.thread_id"];
  return typeof threadId === "string" ? threadId : undefined;
}

const toMs = ([seconds, nanos]: [number, number]) =>
  seconds * 1000 + nanos / 1e6;

/**
 * Finished spans as `spans` rows. Only an agent's root span names the agent,
 * so each span takes the name from the root of its trace.
 */
export function toSpanRows(spans: ReadableSpan[]): Infer<typeof vSpan>[] {
  const agentByTrace = new Map<string, string>();
  for (const span of spans) {
    const agent = span.attributes["gen_ai.agent.name"];
    if (typeof agent === "string") {
      agentByTrace.set(span.spanContext().traceId, agent);
    }
  }
  return spans.map((span) =>
    toSpanRow(span, agentByTrace.get(span.spanContext().traceId)),
  );
}

/** A finished span as a `spans` row. Attributes are kept as recorded. */
function toSpanRow(
  span: ReadableSpan,
  agent: string | undefined,
): Infer<typeof vSpan> {
  const a = span.attributes;
  const str = (key: string) =>
    typeof a[key] === "string" ? (a[key] as string) : undefined;
  const num = (key: string) =>
    typeof a[key] === "number" ? (a[key] as number) : undefined;
  const { traceId, spanId } = span.spanContext();
  return {
    threadId: threadOf(span)!,
    promptMessageId: str("convex.prompt_message_id"),
    traceId,
    spanId,
    parentSpanId: span.parentSpanContext?.spanId,
    agent,
    name: span.name,
    operation: str("gen_ai.operation.name"),
    model: str("gen_ai.response.model") ?? str("gen_ai.request.model"),
    startedAt: toMs(span.startTime),
    ms: toMs(span.duration),
    // `SpanStatusCode.ERROR`.
    error:
      span.status.code === 2 ? (span.status.message ?? "error") : undefined,
    inputTokens: num("gen_ai.usage.input_tokens"),
    outputTokens: num("gen_ai.usage.output_tokens"),
    attributes: JSON.stringify(a),
  };
}
