// The agents' OpenTelemetry spans, kept in the deployment beside the threads
// they belong to, so a week of them can be read with one query:
//
//   npx convex run debugging/spans:summary '{"days":7}'
//
// Spans still go to an OTLP endpoint too when one is set (see telemetry.ts).
//
// An agent call is traced by passing `telemetry: telemetryFor(...)`, and the
// action that makes it runs inside `withTelemetry`, which saves the spans.
import { OpenTelemetry } from "@ai-sdk/otel";
import type { TelemetryOptions } from "ai";
import { type Infer, v } from "convex/values";
import { internal } from "../_generated/api";
import type { ActionCtx, QueryCtx } from "../_generated/server";
import { internalMutation, internalQuery } from "../_generated/server";
import { spanBuffer, toSpanRows } from "./spanBuffer";
import { vSpan } from "./tables";
import { tracerProvider } from "./telemetry";

export const DAY = 24 * 60 * 60 * 1000;
/** How long spans are kept. */
const KEEP_DAYS = 30;
/** Most spans `summary` reads; past it, `truncated` is true. */
const SUMMARY_LIMIT = 5000;

/**
 * Telemetry for one agent call: its spans are named for `functionId` and
 * tagged with the thread, and record no message content.
 */
export function telemetryFor(
  functionId: string,
  threadId: string,
  promptMessageId?: string,
): TelemetryOptions {
  return {
    functionId,
    integrations: new OpenTelemetry({
      tracer: tracerProvider.getTracer("gen_ai"),
      agentSpanName: "functionId",
      enrichSpan: () => ({
        "convex.thread_id": threadId,
        "convex.prompt_message_id": promptMessageId,
      }),
    }),
    recordInputs: false,
    recordOutputs: false,
  };
}

/**
 * Runs `work`, then saves the spans its agent calls made on `threadId`,
 * whether it succeeded or threw.
 */
export async function withTelemetry<T>(
  ctx: ActionCtx,
  threadId: string,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } finally {
    await saveTelemetry(ctx, threadId);
  }
}

/**
 * Sends this action's spans to the OTLP endpoint, if one is set, and saves
 * this thread's to the `spans` table. It never throws: a telemetry failure
 * must not retry a model call that already finished.
 */
async function saveTelemetry(ctx: ActionCtx, threadId: string) {
  try {
    await tracerProvider.forceFlush();
  } catch (error) {
    console.error("Failed to flush telemetry", error);
  }
  const spans = toSpanRows(spanBuffer.take(threadId));
  if (!spans.length) return;
  try {
    await ctx.runMutation(internal.debugging.spans.record, { spans });
  } catch (error) {
    console.error("Failed to save spans", error);
  }
}

export const record = internalMutation({
  args: { spans: v.array(vSpan) },
  returns: v.null(),
  handler: async (ctx, { spans }) => {
    for (const span of spans) await ctx.db.insert("spans", span);
    return null;
  },
});

const vStep = v.object({
  /** Whose step it is: a span like "step 1" means little without it. */
  agent: v.optional(v.string()),
  name: v.string(),
  count: v.number(),
  errors: v.number(),
  meanMs: v.number(),
  p95Ms: v.number(),
  inputTokens: v.number(),
  outputTokens: v.number(),
  /** Threads to read first: the ones that failed, then the slowest. */
  examples: v.array(
    v.object({
      threadId: v.string(),
      ms: v.number(),
      error: v.optional(v.string()),
    }),
  ),
});

/** What `summarizeSpans` returns. */
export const vSpanSummary = v.object({
  since: v.number(),
  spans: v.number(),
  truncated: v.boolean(),
  steps: v.array(vStep),
});

/**
 * The last `days` of spans, by agent and name, most time spent first: what
 * each step costs, how often it fails, and which threads to read about it.
 */
export const summary = internalQuery({
  args: { days: v.optional(v.number()) },
  returns: vSpanSummary,
  handler: (ctx, { days = 7 }) => summarizeSpans(ctx, Date.now() - days * DAY),
});

/**
 * Spans since `since`, by agent and name. With `agents`, only the agents
 * whose name starts with it, e.g. "easygov/".
 */
export async function summarizeSpans(
  ctx: QueryCtx,
  since: number,
  agents?: string,
): Promise<Infer<typeof vSpanSummary>> {
  const found = await ctx.db
    .query("spans")
    .withIndex("by_creation_time", (q) => q.gt("_creationTime", since))
    .order("desc")
    .take(SUMMARY_LIMIT + 1);
  const spans = found
    .slice(0, SUMMARY_LIMIT)
    .filter((span) => !agents || span.agent?.startsWith(agents));
  const byStep = new Map<string, typeof spans>();
  for (const span of spans) {
    const key = JSON.stringify([span.agent ?? null, span.name]);
    byStep.set(key, [...(byStep.get(key) ?? []), span]);
  }
  const steps = [...byStep.values()].map((all) => {
    const { agent, name } = all[0];
    const ms = all.map((s) => s.ms).sort((a, b) => a - b);
    const failed = all.filter((s) => s.error !== undefined);
    const slowest = [...all].sort((a, b) => b.ms - a.ms);
    const examples = [...new Set([...failed, ...slowest])]
      .slice(0, 3)
      .map(({ threadId, ms, error }) => ({ threadId, ms, error }));
    const sum = (pick: (s: (typeof all)[number]) => number | undefined) =>
      all.reduce((total, s) => total + (pick(s) ?? 0), 0);
    return {
      agent,
      name,
      count: all.length,
      errors: failed.length,
      meanMs: Math.round(sum((s) => s.ms) / all.length),
      p95Ms: Math.round(
        ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.95))],
      ),
      inputTokens: sum((s) => s.inputTokens),
      outputTokens: sum((s) => s.outputTokens),
      examples,
    };
  });
  steps.sort((a, b) => b.meanMs * b.count - a.meanMs * a.count);
  return {
    since,
    spans: spans.length,
    truncated: found.length > SUMMARY_LIMIT,
    steps,
  };
}

/** Deletes spans older than `KEEP_DAYS`, a batch at a time. */
export const prune = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const old = await ctx.db
      .query("spans")
      .withIndex("by_creation_time", (q) =>
        q.lt("_creationTime", Date.now() - KEEP_DAYS * DAY),
      )
      .take(500);
    for (const span of old) await ctx.db.delete("spans", span._id);
    if (old.length === 500) {
      await ctx.scheduler.runAfter(0, internal.debugging.spans.prune, {});
    }
    return null;
  },
});
