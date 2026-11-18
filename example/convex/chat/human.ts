// See the docs at https://docs.convex.dev/agents/human-agents
import {
  saveMessage,
  syncStreams,
  vStreamArgs,
  listUIMessages,
  listMessages,
  type MessageDoc,
  Agent,
} from "@convex-dev/agent";
import {
  action,
  internalAction,
  internalMutation,
  mutation,
  query,
  type QueryCtx,
  type MutationCtx,
} from "../_generated/server";
import { v } from "convex/values";
import { components, internal } from "../_generated/api";
import { paginationOptsValidator } from "convex/server";
import { authorizeThreadAccess } from "../threads";
import { z } from "zod/v3";
import { tool } from "ai";
import { defaultConfig } from "../agents/config";
import { getAuthUserId } from "../utils";

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
  description:
    "Send a question to the human-support inbox and wait for their reply.",
  inputSchema: z.object({
    question: z.string().describe("The question to ask the human"),
  }),
});

const humanAgent = new Agent(components.agent, {
  ...defaultConfig,
  name: "Human Support Agent",
  tools: { askHuman },
  instructions:
    "You are a support assistant with a working human-support inbox. " +
    "Use askHuman when the user asks to contact a human or needs a staff decision you cannot make. " +
    "The tool creates a real pending request in this demo's inbox and pauses until support replies. " +
    "Do not claim you cannot contact a human: askHuman is available. " +
    "Treat askHuman results as the human's response. Clearly relay a useful response to the user. " +
    "If the response is unclear or insufficient, your next step must be an askHuman tool call asking the human to clarify the original question. " +
    "For example, a human reply of 'What', '?', or 'not sure' is not an eligibility decision or a request for customer details. Quote that reply and ask the human what they mean. " +
    "Never invent what the human said or imply that they asked for information they did not request. " +
    "When the human actually requests more customer information, relay that request to the user. " +
    "If the request was cancelled, acknowledge that no human answer was supplied. " +
    "Never claim a refund or other external action was performed by this demo. Use clear, professional language.",
});

export const ask = action({
  args: { question: v.string(), threadId: v.string() },
  handler: async (ctx, { question, threadId }) => {
    await authorizeThreadAccess(ctx, threadId);
    const result = await humanAgent.generateText(
      ctx,
      { threadId },
      {
        prompt: question,
      },
    );
    const supportRequests = result.toolCalls
      .filter((tc) => tc.toolName === "askHuman" && !tc.dynamic)
      .map(({ toolCallId, input: { question } }) => ({
        toolCallId,
        question,
      }));
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
    await humanAgent.saveMessage(ctx, {
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
    await humanAgent.generateText(
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
    const thread = await ctx.runQuery(components.agent.threads.getThread, {
      threadId: args.threadId,
    });
    if (!thread)
      return {
        page: [],
        isDone: true,
        continueCursor: "",
        streams:
          args.streamArgs?.kind === "deltas"
            ? { kind: "deltas" as const, deltas: [] }
            : { kind: "list" as const, messages: [] },
      };
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

async function pendingHumanRequests(
  ctx: QueryCtx | MutationCtx,
  threadId: string,
) {
  const messages: MessageDoc[] = [];
  let cursor: string | null = null;
  // shortcut: scan demo histories, use an indexed inbox when histories approach query read limits.
  while (true) {
    const result = await listMessages(ctx, components.agent, {
      threadId,
      paginationOpts: { cursor, numItems: 100 },
    });
    messages.push(...result.page);
    if (result.isDone) break;
    cursor = result.continueCursor;
  }
  const answered = new Set<string>();
  for (const { message } of messages) {
    if (message?.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type === "tool-result") answered.add(part.toolCallId);
    }
  }
  return messages.flatMap(
    ({ message, _id, _creationTime, order, stepOrder }) => {
      if (message?.role !== "assistant" || !Array.isArray(message.content))
        return [];
      return message.content.flatMap((part) => {
        if (
          part.type !== "tool-call" ||
          part.toolName !== "askHuman" ||
          answered.has(part.toolCallId)
        )
          return [];
        const input = z.object({ question: z.string() }).safeParse(part.input);
        return input.success
          ? [
              {
                toolCallId: part.toolCallId,
                question: input.data.question,
                messageId: _id,
                createdAt: _creationTime,
                order,
                stepOrder,
              },
            ]
          : [];
      });
    },
  );
}

export const listPendingRequests = query({
  args: { threadId: v.string() },
  handler: async (ctx, { threadId }) => {
    if (!(await ctx.runQuery(components.agent.threads.getThread, { threadId })))
      return [];
    await authorizeThreadAccess(ctx, threadId, true);
    return pendingHumanRequests(ctx, threadId);
  },
});

export const listInbox = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    const threads = await ctx.runQuery(
      components.agent.threads.listThreadsByUserId,
      {
        userId: await getAuthUserId(ctx),
        paginationOpts,
      },
    );
    const requests = await Promise.all(
      threads.page.map(async (thread) =>
        (await pendingHumanRequests(ctx, thread._id)).map((request) => ({
          ...request,
          threadId: thread._id,
          threadTitle: thread.title ?? "Untitled conversation",
        })),
      ),
    );
    return { ...threads, page: requests.flat() };
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
    await completeHumanRequest(
      ctx,
      { threadId, toolCallId },
      { kind: "reply", humanName, response },
    );
  },
});

export const deleteRequest = mutation({
  args: { threadId: v.string(), toolCallId: v.string() },
  handler: async (ctx, request) => {
    await completeHumanRequest(ctx, request, { kind: "cancel" });
  },
});

export const deleteConversation = mutation({
  args: { threadId: v.string() },
  handler: async (ctx, { threadId }) => {
    await authorizeThreadAccess(ctx, threadId, true);
    await humanAgent.deleteThreadAsync(ctx, { threadId });
  },
});

async function completeHumanRequest(
  ctx: MutationCtx,
  { threadId, toolCallId }: { threadId: string; toolCallId: string },
  completion:
    | { kind: "reply"; humanName: string; response: string }
    | { kind: "cancel" },
): Promise<void> {
  await authorizeThreadAccess(ctx, threadId, true);
  if (
    completion.kind === "reply" &&
    (!completion.humanName.trim() || !completion.response.trim())
  )
    throw new Error("Name and response are required");
  const pending = await pendingHumanRequests(ctx, threadId);
  const requested = pending.find(
    (request) => request.toolCallId === toolCallId,
  );
  if (!requested)
    throw new Error("This human request is missing or already answered");
  const { messageId } = await humanAgent.saveMessage(ctx, {
    threadId,
    order: requested.order,
    message: {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId,
          toolName: "askHuman",
          output:
            completion.kind === "reply"
              ? { type: "text", value: completion.response }
              : {
                  type: "error-text",
                  value:
                    "The human request was cancelled without an answer. Do not treat this as approval or invent a human response.",
                },
        },
      ],
    },
    metadata: {
      provider: "human",
      providerMetadata: {
        human:
          completion.kind === "reply"
            ? { name: completion.humanName }
            : { cancelled: true },
      },
    },
  });
  const waitingForSibling = pending.some(
    (request) =>
      request.toolCallId !== toolCallId &&
      request.order === requested.order &&
      request.stepOrder === requested.stepOrder,
  );
  if (!waitingForSibling)
    await ctx.scheduler.runAfter(
      0,
      internal.chat.human.continueAfterHumanResponse,
      { threadId, promptMessageId: messageId },
    );
}

export const continueAfterHumanResponse = humanAgent.asTextAction({});
