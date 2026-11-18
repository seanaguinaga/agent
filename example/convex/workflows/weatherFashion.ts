// Backs the "Durable weather workflow" page (ui/workflows/WeatherFashion.tsx).
// See the docs at https://docs.convex.dev/agents/messages and
// https://docs.convex.dev/agents/streaming
import {
  listUIMessages,
  syncStreams,
  vStreamArgs,
} from "@convex-dev/agent";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { components, internal } from "../_generated/api";
import { internalAction, mutation, query } from "../_generated/server";
import { fashionAgent } from "../agents/fashion";
import { authorizeThreadAccess } from "../threads";

export const listMessages = query({
  args: {
    threadId: v.string(),
    paginationOpts: paginationOptsValidator,
    streamArgs: vStreamArgs,
  },
  handler: async (ctx, args) => {
    await authorizeThreadAccess(ctx, args.threadId);
    const paginated = await listUIMessages(ctx, components.agent, args);
    const streams = await syncStreams(ctx, components.agent, args);

    // The client merges assistant messages for a turn but keeps their parts.
    const page = paginated.page.map((message) =>
      message.role === "assistant" && message.status === "failed"
        ? {
            ...message,
            parts: [
              ...message.parts,
              { type: "data-failedAttempt" as const, data: null },
            ],
          }
        : message,
    );
    return { ...paginated, page, streams };
  },
});

/**
 * Saves a follow-up question, then streams the fashion agent's answer as
 * deltas, which `useUIMessages({ stream: true })` picks up.
 */
export const askFollowUp = mutation({
  args: { threadId: v.string(), prompt: v.string() },
  returns: v.null(),
  handler: async (ctx, { threadId, prompt }) => {
    await authorizeThreadAccess(ctx, threadId);
    const { messageId } = await fashionAgent.saveMessage(ctx, {
      threadId,
      prompt,
      skipEmbeddings: true,
    });
    await ctx.scheduler.runAfter(
      0,
      internal.workflows.weatherFashion.streamFollowUp,
      { threadId, promptMessageId: messageId },
    );
    return null;
  },
});

export const streamFollowUp = internalAction({
  args: { threadId: v.string(), promptMessageId: v.string() },
  returns: v.null(),
  handler: async (ctx, { threadId, promptMessageId }) => {
    const result = await fashionAgent.streamText(
      ctx,
      { threadId },
      { promptMessageId },
      { saveStreamDeltas: { chunking: "word", throttleMs: 100 } },
    );
    await result.consumeStream();
    return null;
  },
});
