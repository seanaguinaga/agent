// See the docs at https://docs.convex.dev/agents/tool-approval
//
// Tool Approval Flow:
// 1. User sends message → model calls a tool with needsApproval
// 2. Generation stops with a tool-approval-request in the response
// 3. Client shows Approve/Deny buttons to the user
// 4. User clicks Approve or Deny → saves response, schedules continuation
// 5. AI SDK automatically handles the approval: executes tool (if approved)
//    or creates execution-denied result (if denied), then continues generation
import { paginationOptsValidator } from "convex/server";
import { listUIMessages, syncStreams, vStreamArgs } from "@convex-dev/agent";
import { components, internal } from "../_generated/api";
import { internalAction, mutation, query } from "../_generated/server";
import type { MutationCtx } from "../_generated/server";
import { v } from "convex/values";
import { approvalAgent } from "../agents/approval";
import { authorizeThreadAccess } from "../threads";

type ApprovalLogContext = {
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  requestMessageId?: string;
};

type ApprovalBatchStatus = {
  resolvedCount: number;
  pendingApprovals: Array<
    ApprovalLogContext & {
      approvalId: string;
    }
  >;
};

async function findApprovalLogContext(
  ctx: MutationCtx,
  threadId: string,
  approvalId: string,
): Promise<ApprovalLogContext> {
  const messages = await approvalAgent.listMessages(ctx, {
    threadId,
    paginationOpts: { cursor: null, numItems: 100 },
  });
  for (const message of messages.page) {
    const content = message.message?.content;
    if (!Array.isArray(content)) continue;
    const approvalRequest = content.find(
      (part: any) =>
        part.type === "tool-approval-request" && part.approvalId === approvalId,
    ) as { toolCallId?: string } | undefined;
    if (!approvalRequest?.toolCallId) continue;
    const toolCall = content.find(
      (part: any) =>
        part.type === "tool-call" &&
        part.toolCallId === approvalRequest.toolCallId,
    ) as
      | {
          toolName?: string;
          input?: unknown;
          args?: unknown;
        }
      | undefined;
    return {
      toolCallId: approvalRequest.toolCallId,
      toolName: toolCall?.toolName,
      input: toolCall?.input ?? toolCall?.args,
      requestMessageId: message._id,
    };
  }
  return {};
}

async function getApprovalBatchStatus(
  ctx: MutationCtx,
  threadId: string,
  approvalResponseMessageId: string,
): Promise<ApprovalBatchStatus> {
  const messages = await approvalAgent.listMessages(ctx, {
    threadId,
    paginationOpts: { cursor: null, numItems: 100 },
  });
  const responseMessage = messages.page.find(
    (message) => message._id === approvalResponseMessageId,
  );
  const responseContent = responseMessage?.message?.content;
  const responseParts: Array<{ approvalId: string }> = Array.isArray(
    responseContent,
  )
    ? (responseContent.filter(
        (part: any) => part.type === "tool-approval-response",
      ) as Array<{ approvalId: string }>)
    : [];
  const resolvedApprovalIds = new Set(
    responseParts.map((part) => part.approvalId),
  );
  const firstApprovalId = responseParts[0]?.approvalId;
  if (!firstApprovalId) {
    return { resolvedCount: 0, pendingApprovals: [] };
  }

  for (const message of messages.page) {
    const content = message.message?.content;
    if (!Array.isArray(content)) continue;
    const sameApprovalStep = content.some(
      (part: any) =>
        part.type === "tool-approval-request" &&
        part.approvalId === firstApprovalId,
    );
    if (!sameApprovalStep) continue;

    const pendingApprovals = content
      .filter(
        (part: any) =>
          part.type === "tool-approval-request" &&
          !resolvedApprovalIds.has(part.approvalId),
      )
      .map((approvalRequest: any) => {
        const toolCall = content.find(
          (part: any) =>
            part.type === "tool-call" &&
            part.toolCallId === approvalRequest.toolCallId,
        ) as
          | {
              toolName?: string;
              input?: unknown;
              args?: unknown;
            }
          | undefined;
        return {
          approvalId: approvalRequest.approvalId,
          toolCallId: approvalRequest.toolCallId,
          toolName: toolCall?.toolName,
          input: toolCall?.input ?? toolCall?.args,
          requestMessageId: message._id,
        };
      });
    return {
      resolvedCount: resolvedApprovalIds.size,
      pendingApprovals,
    };
  }

  return { resolvedCount: resolvedApprovalIds.size, pendingApprovals: [] };
}

/**
 * Send a message and start generation.
 * If the model calls a tool that needs approval, generation will pause
 * and the tool-approval-request will appear in the thread messages.
 */
export const sendMessage = mutation({
  args: { prompt: v.string(), threadId: v.string() },
  handler: async (ctx, { prompt, threadId }) => {
    await authorizeThreadAccess(ctx, threadId);
    const { messageId } = await approvalAgent.saveMessage(ctx, {
      threadId,
      prompt,
      skipEmbeddings: true,
    });
    await ctx.scheduler.runAfter(0, internal.chat.approval.generateResponse, {
      threadId,
      promptMessageId: messageId,
    });
    return { messageId };
  },
});

/**
 * Generate a response. If a tool requires approval, generation stops
 * and the approval-request is persisted in the thread.
 */
export const generateResponse = internalAction({
  args: { promptMessageId: v.string(), threadId: v.string() },
  handler: async (ctx, { promptMessageId, threadId }) => {
    const result = await approvalAgent.streamText(
      ctx,
      { threadId },
      { promptMessageId },
      { saveStreamDeltas: { chunking: "word", throttleMs: 100 } },
    );
    await result.consumeStream();
  },
});

/**
 * Submit an approval decision for a single tool call.
 * Saves the decision but does NOT continue generation — the client
 * calls continueAfterApprovals once all pending approvals are resolved.
 */
export const submitApproval = mutation({
  args: {
    threadId: v.string(),
    approvalId: v.string(),
    approved: v.boolean(),
    reason: v.optional(v.string()),
  },
  returns: v.object({ messageId: v.string() }),
  handler: async (ctx, { threadId, approvalId, approved, reason }) => {
    await authorizeThreadAccess(ctx, threadId);
    const approvalContext = await findApprovalLogContext(
      ctx,
      threadId,
      approvalId,
    );
    const { messageId } = approved
      ? await approvalAgent.approveToolCall(ctx, {
          threadId,
          approvalId,
          reason,
        })
      : await approvalAgent.denyToolCall(ctx, { threadId, approvalId, reason });
    console.log("[tool-approval] decision saved", {
      threadId,
      approvalId,
      ...approvalContext,
      approved,
      reason,
      messageId,
    });
    if (!approved) {
      console.warn("[tool-approval] denied state recorded", {
        threadId,
        approvalId,
        ...approvalContext,
        reason,
        messageId,
      });
    }
    return { messageId };
  },
});

/**
 * Continue generation after all approvals in a step have been resolved.
 * The client calls this once every pending tool call has been approved or denied.
 */
export const continueAfterApprovals = internalAction({
  args: {
    threadId: v.string(),
    lastApprovalMessageId: v.string(),
  },
  handler: async (ctx, { threadId, lastApprovalMessageId }) => {
    console.log("[tool-approval] continuing after approvals", {
      threadId,
      lastApprovalMessageId,
    });
    const result = await approvalAgent.streamText(
      ctx,
      { threadId },
      { promptMessageId: lastApprovalMessageId },
      { saveStreamDeltas: { chunking: "word", throttleMs: 100 } },
    );
    await result.consumeStream();
  },
});

/**
 * Schedule continuation after all approvals are resolved.
 * Called by the client when hasPendingApprovals becomes false.
 */
export const triggerContinuation = mutation({
  args: {
    threadId: v.string(),
    lastApprovalMessageId: v.string(),
  },
  handler: async (ctx, { threadId, lastApprovalMessageId }) => {
    await authorizeThreadAccess(ctx, threadId);
    const batchStatus = await getApprovalBatchStatus(
      ctx,
      threadId,
      lastApprovalMessageId,
    );
    if (batchStatus.pendingApprovals.length > 0) {
      console.log("[tool-approval] continuation skipped; approvals pending", {
        threadId,
        lastApprovalMessageId,
        resolvedCount: batchStatus.resolvedCount,
        pendingApprovals: batchStatus.pendingApprovals,
      });
      return;
    }
    console.log("[tool-approval] scheduling continuation", {
      threadId,
      lastApprovalMessageId,
      resolvedCount: batchStatus.resolvedCount,
    });
    await ctx.scheduler.runAfter(
      0,
      internal.chat.approval.continueAfterApprovals,
      { threadId, lastApprovalMessageId },
    );
  },
});

/**
 * Query messages with streaming support.
 */
export const listThreadMessages = query({
  args: {
    threadId: v.string(),
    paginationOpts: paginationOptsValidator,
    streamArgs: vStreamArgs,
  },
  handler: async (ctx, args) => {
    const { threadId, streamArgs } = args;
    await authorizeThreadAccess(ctx, threadId);
    const streams = await syncStreams(ctx, components.agent, {
      threadId,
      streamArgs,
    });
    const paginated = await listUIMessages(ctx, components.agent, args);
    return { ...paginated, streams };
  },
});
