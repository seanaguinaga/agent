// See the docs at https://docs.convex.dev/agents/workflows
import { OpenTelemetry } from "@ai-sdk/otel";
import { createThread, saveMessage, stepCountIs } from "@convex-dev/agent";
import { WorkflowId, WorkflowManager } from "@convex-dev/workflow";
import { type TelemetryOptions } from "ai";
import { v } from "convex/values";
import { components, internal } from "../_generated/api";
import { action, internalAction, mutation } from "../_generated/server";
import { fashionAgent } from "../agents/fashion";
import { weatherAgent } from "../agents/weather";
import { tracerProvider } from "../debugging/telemetry";
import { authorizeThreadAccess } from "../threads";
import { getAuthUserId } from "../utils";
import { outfitSchema } from "./outfit";
import { weatherQuestion } from "./prompts";

export { weatherQuestion };

function telemetryFor(
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

async function flushTelemetry() {
  try {
    await tracerProvider.forceFlush();
  } catch (error) {
    // An exporter failure must not retry an already completed agent call.
    console.error("Failed to flush chaining telemetry", error);
  }
}

/**
 * OPTION 1: Chain agent calls in a single action.
 *
 * This will do two steps in sequence with different agents:
 *
 * 1. Get the weather forecast
 * 2. Get fashion advice based on the weather
 */

export const getAdvice = action({
  args: { location: v.string(), threadId: v.string() },
  handler: async (ctx, { location, threadId }) => {
    await authorizeThreadAccess(ctx, threadId);
    const userId = await getAuthUserId(ctx);

    try {
      // Note: the message is saved automatically, and clients will get the
      // response via subscriptions automatically.
      await weatherAgent.generateText(
        ctx,
        { threadId, userId },
        {
          prompt: weatherQuestion(location),
          telemetry: telemetryFor(
            "workflows/chaining/getAdvice/weather",
            threadId,
          ),
        },
      );

      // This includes previous message history from the thread automatically.
      await fashionAgent.generateText(
        ctx,
        { threadId, userId },
        {
          prompt: `What should I wear based on the weather?`,
          telemetry: telemetryFor(
            "workflows/chaining/getAdvice/fashion",
            threadId,
          ),
        },
      );
    } finally {
      await flushTelemetry();
    }
  },
});

/**
 * OPTION 2: Use agent actions in a workflow
 *
 * Workfows are durable functions that can survive server failures and retry
 * each step, calling queries, mutations, or actions.

 * They have higher guarantees around running to completion than normal
 * serverless functions. Each time a step finishes, the workflow re-executes,
 * fast-forwarding past steps it's already completed.
 */

export const workflow = new WorkflowManager(components.workflow);

export const weatherAgentWorkflow = workflow.define({
  args: {
    location: v.string(),
    threadId: v.string(),
    // Saved by `startWorkflow` so the question shows up right away. Workflows
    // started before that change save it here instead.
    promptMessageId: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { location, threadId, promptMessageId },
  ): Promise<void> => {
    const weatherQ = promptMessageId
      ? { messageId: promptMessageId }
      : await saveMessage(ctx, components.agent, {
          threadId,
          prompt: weatherQuestion(location),
        });
    const forecast = await ctx.runAction(
      internal.workflows.chaining.getForecast,
      { promptMessageId: weatherQ.messageId, threadId },
      { retry: true },
    );
    const fashionQ = await saveMessage(ctx, components.agent, {
      threadId,
      prompt: `What should I wear based on the weather?`,
    });
    const fashion = await ctx.runAction(
      internal.workflows.chaining.getFashionAdvice,
      { promptMessageId: fashionQ.messageId, threadId },
      {
        retry: { maxAttempts: 5, initialBackoffMs: 1000, base: 2 },
        // runAfter: 2 * 1000, // To add artificial delay
      },
    );
  },
});

export const startWorkflow = mutation({
  args: { location: v.string() },
  handler: async (
    ctx,
    { location },
    // It's best practice to annotate return types on all functions involved
    // in workflows, as circular types are common.
  ): Promise<{ threadId: string; workflowId: WorkflowId }> => {
    const userId = await getAuthUserId(ctx);
    const threadId = await createThread(ctx, components.agent, {
      userId,
      title: `Weather in ${location}`,
    });
    // Saving the question in this mutation (not the workflow) means it's in
    // the thread as soon as the page has a threadId to subscribe to.
    const { messageId: promptMessageId } = await saveMessage(
      ctx,
      components.agent,
      { threadId, prompt: weatherQuestion(location) },
    );
    const workflowId = await workflow.start(
      ctx,
      internal.workflows.chaining.weatherAgentWorkflow,
      { location, threadId, promptMessageId },
    );
    // Lets the page show whether this thread's workflow is still running.
    await ctx.db.insert("threadWorkflows", { threadId, workflowId });
    return { threadId, workflowId };
  },
});

/**
 * Each durable step runs separately, so flush inside its action even on failure.
 * Retries produce separate traces correlated by threadId and promptMessageId.
 *
 * The forecast streams: deltas are saved as they're generated, so clients
 * subscribed with `useUIMessages({ stream: true })` see it type out live.
 */
export const getForecast = internalAction({
  args: { threadId: v.string(), promptMessageId: v.string() },
  handler: async (ctx, { threadId, promptMessageId }) => {
    // A failed stream surfaces as a generic abort; keep the real cause.
    let streamError: unknown;
    try {
      const result = await weatherAgent.streamText(
        ctx,
        { threadId },
        {
          promptMessageId,
          stopWhen: stepCountIs(3),
          telemetry: telemetryFor(
            "workflows/chaining/getForecast",
            threadId,
            promptMessageId,
          ),
          onError: ({ error }) => {
            streamError ??= error;
          },
        },
        { saveStreamDeltas: { chunking: "word", throttleMs: 100 } },
      );
      // Read the whole stream so every step is saved before returning.
      const [text, finishReason, warnings] = await Promise.all([
        result.text,
        result.finishReason,
        result.warnings,
      ]).catch((error: unknown) => {
        throw streamError ?? error;
      });
      return {
        text,
        promptMessageId: result.promptMessageId,
        order: result.order,
        finishReason,
        warnings,
        savedMessageIds: result.savedMessages?.map((m) => m._id) ?? [],
      };
    } finally {
      await flushTelemetry();
    }
  },
});
export const getFashionAdvice = internalAction({
  args: { threadId: v.string(), promptMessageId: v.string() },
  handler: async (ctx, { threadId, promptMessageId }) => {
    try {
      const result = await fashionAgent.generateObject(
        ctx,
        { threadId },
        {
          promptMessageId,
          schema: outfitSchema,
          telemetry: telemetryFor(
            "workflows/chaining/getFashionAdvice",
            threadId,
            promptMessageId,
          ),
        },
      );
      return {
        object: result.object,
        promptMessageId: result.promptMessageId,
        order: result.order,
        finishReason: result.finishReason,
        warnings: result.warnings,
        savedMessageIds: result.savedMessages?.map((m) => m._id) ?? [],
      };
    } finally {
      await flushTelemetry();
    }
  },
});
