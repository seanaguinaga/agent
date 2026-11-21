import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * One finished OpenTelemetry span, kept in the deployment so it can be read
 * beside the thread it belongs to. No message content: the agents' telemetry
 * records neither inputs nor outputs.
 */
export const vSpan = v.object({
  threadId: v.string(),
  promptMessageId: v.optional(v.string()),
  traceId: v.string(),
  spanId: v.string(),
  parentSpanId: v.optional(v.string()),
  /**
   * The agent whose call this span is part of: its `functionId`, e.g.
   * "workflows/chaining/getForecast". Taken from the root of the trace.
   */
  agent: v.optional(v.string()),
  /** e.g. "invoke_agent workflows/chaining/getForecast", "execute_tool …". */
  name: v.string(),
  /** `gen_ai.operation.name`: invoke_agent, chat, execute_tool… */
  operation: v.optional(v.string()),
  model: v.optional(v.string()),
  startedAt: v.number(),
  ms: v.number(),
  /** Set when the span ended in error: its status message. */
  error: v.optional(v.string()),
  inputTokens: v.optional(v.number()),
  outputTokens: v.optional(v.number()),
  /** Every attribute as recorded, as JSON. */
  attributes: v.string(),
});

export default {
  spans: defineTable(vSpan).index("by_threadId", ["threadId"]),
};
