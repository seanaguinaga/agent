// See the docs at https://docs.convex.dev/agents/workflows
import { WorkflowId, WorkflowManager } from "@convex-dev/workflow";
import { OpenTelemetry } from "@ai-sdk/otel";
import { createThread, saveMessage, stepCountIs } from "@convex-dev/agent";
import { type TelemetryOptions } from "ai";
import { components, internal } from "../_generated/api";
import { action, internalAction, mutation } from "../_generated/server";
import { v } from "convex/values";
import { weatherAgent } from "../agents/weather";
import { fashionAgent } from "../agents/fashion";
import { getAuthUserId } from "../utils";
import { authorizeThreadAccess } from "../threads";
import { tracerProvider } from "../debugging/telemetry";
import { outfitSchema } from "./outfit";

/**
 * The weather question for a user-supplied location. The location is quoted
 * so the agent can see where it starts and ends, and the weather agent's
 * instructions say to treat it only as a place name, never as instructions.
 * The eval runner asks the same question, so evals test this exact prompt.
 */
export function weatherQuestion(location: string): string {
  return `What is the weather in "${location.replaceAll('"', "'")}"?`;
}

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
  args: { location: v.string(), threadId: v.string() },
  handler: async (ctx, { location, threadId }): Promise<void> => {
    const weatherQ = await saveMessage(ctx, components.agent, {
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
    console.log("Weather forecast:", forecast);
    console.log("Fashion advice:", fashion.object);
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
    const workflowId = await workflow.start(
      ctx,
      internal.workflows.chaining.weatherAgentWorkflow,
      { location, threadId },
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
