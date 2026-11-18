// See the docs at https://docs.convex.dev/agents/human-agents
import {
  saveMessage,
  syncStreams,
  vStreamArgs,
  listUIMessages,
} from "@convex-dev/agent";
import {
  action,
  internalAction,
  internalMutation,
  mutation,
  query,
} from "../_generated/server";
import { v } from "convex/values";
import { components, internal } from "../_generated/api";
import { paginationOptsValidator } from "convex/server";
import { authorizeThreadAccess } from "../threads";
import { z } from "zod/v3";
import { tool } from "ai";
import { agent } from "../agents/simple";

/**
 * ===============================
 * OPTION 1: Sending messages as an "assistant" role
 * ===============================
 */

/**
 * Sending a message from a human agent.
 * This does not kick off an LLM response.
 * This is an internal mutation that can be called from other functions.
 * To have a logged in support agent send it, you could use a public mutation
 * along with auth to find the support agent's name and ensure they have access
 * to the specified thread.
 */
export const sendMessageFromHumanAgent = internalMutation({
  args: { agentName: v.string(), message: v.string(), threadId: v.string() },
  handler: async (ctx, args) => {
    const { messageId } = await saveMessage(ctx, components.agent, {
      threadId: args.threadId,
      // Start a new order so the reply renders separately from the previous
      // agent turn instead of merging into its UI message.
      order: "next",
      agentName: args.agentName,
      message: {
        role: "assistant",
        content: args.message,
      },
    });
    return messageId;
  },
});

/**
 * Sending a message from a user
 */
export const sendMessageFromUser = mutation({
  args: { message: v.string(), threadId: v.string() },
  handler: async (ctx, args) => {
    await authorizeThreadAccess(ctx, args.threadId);
    await saveMessage(ctx, components.agent, {
      threadId: args.threadId,
      // prompt is shorthand for message: { role: "user", content: prompt }
      prompt: args.message,
    });
  },
});

/**
 * ===============================
 * OPTION 2: Sending messages as a tool call
 * ===============================
 */

export const askHuman = tool({
  description: "Ask a human a question",
  inputSchema: z.object({
    question: z.string().describe("The question to ask the human"),
  }),
});

export const ask = action({
  args: { question: v.string(), threadId: v.string() },
  handler: async (ctx, { question, threadId }) => {
    await authorizeThreadAccess(ctx, threadId);
    const result = await agent.generateText(
      ctx,
      { threadId },
      {
        prompt: question,
        tools: { askHuman },
      },
    );
    const supportRequests = result.toolCalls
      .filter((tc) => tc.toolName === "askHuman" && !tc.dynamic)
      .map(({ toolCallId, input: { question } }) => ({
        toolCallId,
        question,
      }));
    if (supportRequests.length > 0) {
      // Do something so the support agent knows they need to respond,
      // e.g. save a message to their inbox
      // await ctx.runMutation(internal.example.sendToSupport, {
      //   threadId,
      //   supportRequests,
      // });
    }
    return {
      response: result.text,
      supportRequests,
      promptMessageId: result.promptMessageId,
    };
  },
});

export const humanResponseAsToolCall = internalAction({
  args: {
    humanName: v.string(),
    response: v.string(),
    toolCallId: v.string(),
    threadId: v.string(),
    promptMessageId: v.string(),
  },
  handler: async (ctx, args) => {
    await agent.saveMessage(ctx, {
      threadId: args.threadId,
      message: {
        role: "tool",
        content: [
          {
            type: "tool-result",
            output: { type: "text", value: args.response },
            toolCallId: args.toolCallId,
            toolName: "askHuman",
          },
        ],
      },
      metadata: {
        provider: "human",
        providerMetadata: {
          human: { name: args.humanName },
        },
      },
    });
    // Continue generating a response from the LLM
    await agent.generateText(
      ctx,
      { threadId: args.threadId },
      { promptMessageId: args.promptMessageId },
    );
  },
});

/**
 * ===============================
 * Other things
 * ===============================
 */

/**
 * Listing messages without using an agent
 */

export const getMessages = query({
  args: {
    threadId: v.string(),
    paginationOpts: paginationOptsValidator,
    streamArgs: vStreamArgs,
  },
  handler: async (ctx, args) => {
    await authorizeThreadAccess(ctx, args.threadId);
    const messages = await listUIMessages(ctx, components.agent, {
      threadId: args.threadId,
      paginationOpts: args.paginationOpts,
    });
    const streams = await syncStreams(ctx, components.agent, {
      threadId: args.threadId,
      streamArgs: args.streamArgs,
    });
    return { ...messages, streams };
  },
});

export const reply = mutation({
  args: { threadId: v.string(), agentName: v.string(), message: v.string() },
  handler: async (ctx, args): Promise<string> => {
    await authorizeThreadAccess(ctx, args.threadId);
    if (!args.message.trim() || !args.agentName.trim())
      throw new Error("Name and message are required");
    return ctx.runMutation(internal.chat.human.sendMessageFromHumanAgent, args);
  },
});

export const respondToTool = mutation({
  args: {
    threadId: v.string(),
    humanName: v.string(),
    response: v.string(),
    toolCallId: v.string(),
  },
  handler: async (ctx, { threadId, humanName, response, toolCallId }) => {
    await authorizeThreadAccess(ctx, threadId);
    if (!humanName.trim() || !response.trim())
      throw new Error("Name and response are required");
    const { page } = await agent.listMessages(ctx, {
      threadId,
      paginationOpts: { cursor: null, numItems: 100 },
    });
    // shortcut: inspect the latest 100 messages, paginate if demos need longer handoffs.
    const requested = page.find(
      ({ message }) =>
        message?.role === "assistant" &&
        Array.isArray(message.content) &&
        message.content.some(
          (part) =>
            part.type === "tool-call" &&
            part.toolName === "askHuman" &&
            part.toolCallId === toolCallId,
        ),
    );
    const answered = page.some(
      ({ message }) =>
        message?.role === "tool" &&
        message.content.some(
          (part) =>
            part.type === "tool-result" && part.toolCallId === toolCallId,
        ),
    );
    if (!requested || answered)
      throw new Error("This human request is missing or already answered");
    const { messageId } = await agent.saveMessage(ctx, {
      threadId,
      message: {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId,
            toolName: "askHuman",
            output: { type: "text", value: response },
          },
        ],
      },
      metadata: {
        provider: "human",
        providerMetadata: { human: { name: humanName } },
      },
    });
    const answeredCalls = new Set([toolCallId]);
    for (const { message } of page) {
      if (message?.role !== "tool") continue;
      for (const part of message.content) {
        if (part.type === "tool-result") answeredCalls.add(part.toolCallId);
      }
    }
    const stepCalls = Array.isArray(requested.message?.content)
      ? requested.message.content.filter((part) => part.type === "tool-call")
      : [];
    if (stepCalls.every((part) => answeredCalls.has(part.toolCallId)))
      await ctx.scheduler.runAfter(
        0,
        internal.chat.human.continueAfterHumanResponse,
        { threadId, promptMessageId: messageId },
      );
  },
});

export const continueAfterHumanResponse = agent.asTextAction({});
