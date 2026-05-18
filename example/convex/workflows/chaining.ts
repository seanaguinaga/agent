// See the docs at https://docs.convex.dev/agents/workflows
import { WorkflowId, WorkflowManager } from "@convex-dev/workflow";
import { createThread, saveMessage, stepCountIs } from "@convex-dev/agent";
import { components, internal } from "../_generated/api";
import { action, internalAction, mutation } from "../_generated/server";
import { v } from "convex/values";
import { z } from "zod/v3";
import { weatherAgent } from "../agents/weather";
import { fashionAgent } from "../agents/fashion";
import { getAuthUserId } from "../utils";
import {
  assertConfiguredLanguageModel,
  saveErrorMessage,
} from "../errorHandling";
import {
  lookupWeatherForLocation,
  type WeatherLookupResult,
  vWeatherLookupResult,
} from "../tools/weather";

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
    const userId = await getAuthUserId(ctx);

    try {
      assertConfiguredLanguageModel();
      // Note: the message is saved automatically, and clients will get the
      // response via subscriptions automatically.
      await weatherAgent.generateText(
        ctx,
        { threadId, userId },
        { prompt: `What is the weather in ${location}?` },
      );

      // This includes previous message history from the thread automatically.
      await fashionAgent.generateText(
        ctx,
        { threadId, userId },
        { prompt: `What should I wear based on the weather?` },
      );
    } catch (error) {
      await saveErrorMessage(ctx, threadId, error, "Weather Agent");
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

const workflow = new WorkflowManager(components.workflow);

export const weatherAgentWorkflow = workflow.define({
  args: {
    location: v.string(),
    threadId: v.string(),
    userId: v.optional(v.string()),
  },
  handler: async (ctx, { location, threadId, userId }): Promise<void> => {
    try {
      assertConfiguredLanguageModel();
    } catch (error) {
      await saveErrorMessage(ctx, threadId, error, "Weather Agent");
      return;
    }
    const weatherPrompt = `What is the weather in ${location}?`;
    const weatherQ = await saveMessage(ctx, components.agent, {
      threadId,
      prompt: weatherPrompt,
    });
    let weather: WeatherLookupResult;
    try {
      weather = await ctx.runAction(
        internal.workflows.chaining.lookupWeatherForWorkflow,
        { location },
        { retry: { maxAttempts: 3, initialBackoffMs: 1000, base: 2 } },
      );
    } catch (error) {
      await saveErrorMessage(ctx, threadId, error, "Weather Agent");
      return;
    }
    const weatherContext = formatWeatherLookupForPrompt(weather);
    await saveMessage(ctx, components.agent, {
      threadId,
      agentName: "Weather Lookup",
      message: {
        role: "assistant",
        content: weatherContext,
      },
    });
    let forecast: { text: string };
    try {
      forecast = await ctx.runAction(
        internal.workflows.chaining.getForecast,
        {
          promptMessageId: weatherQ.messageId,
          threadId,
          userId,
          toolChoice: "none",
          prompt:
            `${weatherPrompt}\n\n` +
            "Use this structured weather lookup result instead of calling weather tools. " +
            "If it is not live weather, clearly say so and provide useful fallback context.\n\n" +
            weatherContext,
        },
        { retry: { maxAttempts: 2, initialBackoffMs: 1000, base: 2 } },
      );
    } catch (error) {
      await saveErrorMessage(ctx, threadId, error, "Weather Agent");
      return;
    }
    const fashionPrompt = `What should I wear based on the weather in ${location}?`;
    const fashionQ = await saveMessage(ctx, components.agent, {
      threadId,
      prompt: fashionPrompt,
    });
    let fashion: { object: unknown };
    try {
      fashion = await ctx.runAction(
        internal.workflows.chaining.getFashionAdvice,
        {
          promptMessageId: fashionQ.messageId,
          threadId,
          userId,
          prompt:
            `${fashionPrompt}\n\n` +
            "Use the weather lookup result and weather-agent explanation below. " +
            "If the lookup is unavailable or the location was not found, still provide the most helpful conservative response possible and mark it as fallback guidance.\n\n" +
            `${weatherContext}\n\nWeather agent explanation:\n${forecast.text}`,
        },
        {
          retry: { maxAttempts: 2, initialBackoffMs: 1000, base: 2 },
          // runAfter: 2 * 1000, // To add artificial delay
        },
      );
    } catch (error) {
      await saveErrorMessage(ctx, threadId, error, "Fashion Agent");
      return;
    }
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
      { location, threadId, userId },
    );
    return { threadId, workflowId };
  },
});

export const lookupWeatherForWorkflow = internalAction({
  args: { location: v.string() },
  returns: vWeatherLookupResult,
  handler: async (_ctx, { location }): Promise<WeatherLookupResult> => {
    return await lookupWeatherForLocation(location);
  },
});

/**
 * Expose the agents as actions
 *
 * Note: you could alternatively create your own actions that call the agent
 * internally.
 * This is a convenient shorthand.
 */
export const getForecast = weatherAgent.asTextAction({
  stopWhen: stepCountIs(3),
});
export const getFashionAdvice = fashionAgent.asObjectAction({
  schema: z.object({
    hat: z.string(),
    tops: z.string(),
    bottoms: z.string(),
    shoes: z.string(),
  }),
});

function formatWeatherLookupForPrompt(weather: WeatherLookupResult) {
  if (weather.type === "live") {
    return [
      "Structured weather lookup result:",
      `- type: live`,
      `- source: ${weather.source}`,
      `- requestedLocation: ${weather.requestedLocation ?? weather.locationName}`,
      `- locationName: ${weather.locationName}`,
      `- coordinates: ${weather.latitude}, ${weather.longitude}`,
      `- temperature: ${weather.temperature}`,
      `- feelsLike: ${weather.feelsLike}`,
      `- humidity: ${weather.humidity}`,
      `- windSpeed: ${weather.windSpeed}`,
      `- windGust: ${weather.windGust ?? "Unknown"}`,
      `- description: ${weather.description}`,
    ].join("\n");
  }
  if (weather.type === "location_not_found") {
    return [
      "Structured weather lookup result:",
      `- type: location_not_found`,
      `- requestedLocation: ${weather.requestedLocation}`,
      `- reason: ${weather.reason}`,
    ].join("\n");
  }
  return [
    "Structured weather lookup result:",
    `- type: unavailable`,
    `- requestedLocation: ${weather.requestedLocation}`,
    ...(weather.locationName ? [`- locationName: ${weather.locationName}`] : []),
    ...(weather.latitude !== undefined && weather.longitude !== undefined
      ? [`- coordinates: ${weather.latitude}, ${weather.longitude}`]
      : []),
    `- reason: ${weather.reason}`,
    `- fallbackGuidance: ${weather.fallbackGuidance}`,
  ].join("\n");
}
