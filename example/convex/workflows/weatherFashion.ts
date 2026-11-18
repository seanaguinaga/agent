// Backs the "Durable weather workflow" page (ui/workflows/weatherFashion/).
// Messages come from the shared `chat/streaming:listThreadMessages` query, and
// streams are stopped with `chat/streamAbort:abortStreamByOrder`.
// See https://docs.convex.dev/agents/streaming and
// https://docs.convex.dev/agents/workflows
import { abortStream } from "@convex-dev/agent";
import { vOnCompleteArgs, Workpool } from "@convex-dev/workpool";
import { v } from "convex/values";
import { components, internal } from "../_generated/api";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internalMutation, mutation, query } from "../_generated/server";
import { fashionAgent } from "../agents/fashion";
import { STOPPED_BY_USER } from "../chat/streamAbort";
import { authorizeThreadAccess } from "../threads";
import { workflow } from "./chaining";

/**
 * Follow-up answers run through a Workpool rather than `ctx.scheduler`, so
 * only `maxParallelism` of them stream at once. Failed answers aren't retried
 * automatically: the page offers Retry instead.
 */
const followUpPool = new Workpool(components.followUpWorkpool, {
  // Size this to your plan: the Workpool docs suggest at most 20 on the free
  // plan and 100 on Pro, across all pools.
  maxParallelism: 100,
});

/** The question's unfinished job: queued or answering. */
function followUpJob(ctx: QueryCtx, promptMessageId: string) {
  return ctx.db
    .query("followUpJobs")
    .withIndex("by_promptMessageId", (q) =>
      q.eq("promptMessageId", promptMessageId),
    )
    .unique();
}

/** Queues an answer to a saved question, unless one is already on its way. */
async function enqueueFollowUp(
  ctx: MutationCtx,
  threadId: string,
  promptMessageId: string,
) {
  if (await followUpJob(ctx, promptMessageId)) return;
  const workId = await followUpPool.enqueueAction(
    ctx,
    internal.workflows.weatherFashion.streamFollowUp,
    { threadId, promptMessageId },
    {
      retry: false,
      onComplete: internal.workflows.weatherFashion.followUpDone,
      context: { threadId, promptMessageId },
    },
  );
  await ctx.db.insert("followUpJobs", { threadId, promptMessageId, workId });
}

async function workflowFor(ctx: QueryCtx, threadId: string) {
  const row = await ctx.db
    .query("threadWorkflows")
    .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
    .unique();
  return row?.workflowId ?? null;
}

/**
 * The client-facing slice of the workflow package's `WorkflowStatus`, which is
 * only a TypeScript type. It drops `running` (full step records) and `result`,
 * which the page doesn't read.
 */
const vWorkflowStatus = v.union(
  v.object({ type: v.literal("inProgress") }),
  v.object({ type: v.literal("completed") }),
  v.object({ type: v.literal("canceled") }),
  v.object({ type: v.literal("failed"), error: v.string() }),
);

/**
 * Whether the thread's workflow is still running, which includes retrying a
 * failed step. The page hides failed attempts while it is, and offers Retry
 * once it has failed. `null` for threads without a workflow.
 */
export const workflowStatus = query({
  args: { threadId: v.string() },
  returns: v.union(v.null(), vWorkflowStatus),
  handler: async (ctx, { threadId }) => {
    await authorizeThreadAccess(ctx, threadId, true);
    const workflowId = await workflowFor(ctx, threadId);
    if (!workflowId) return null;
    const status = await workflow.status(ctx, workflowId);
    switch (status.type) {
      case "failed":
        // The first line is the message; the rest is a stack trace.
        return { type: "failed" as const, error: status.error.split("\n")[0]! };
      default:
        return { type: status.type };
    }
  },
});

/** Reruns the failed workflow step, keeping the steps that succeeded. */
export const retryWorkflow = mutation({
  args: { threadId: v.string() },
  returns: v.null(),
  handler: async (ctx, { threadId }) => {
    await authorizeThreadAccess(ctx, threadId, true);
    const workflowId = await workflowFor(ctx, threadId);
    if (!workflowId) throw new Error("This thread has no workflow");
    const status = await workflow.status(ctx, workflowId);
    if (status.type !== "failed") {
      throw new Error(`Only a failed workflow can be retried (${status.type})`);
    }
    // Without `from`, restart replays the saved history, failed step included.
    const { page: recentSteps } = await workflow.listSteps(ctx, workflowId, {
      order: "desc",
      paginationOpts: { cursor: null, numItems: 10 },
    });
    const failedStep = recentSteps.find((s) => s.runResult?.kind === "failed");
    await workflow.restart(
      ctx,
      workflowId,
      failedStep ? { from: failedStep.stepNumber } : undefined,
    );
    return null;
  },
});

/**
 * Saves a follow-up question, then streams the fashion agent's answer as
 * deltas (the docs' recommended async streaming pattern).
 */
export const askFollowUp = mutation({
  args: { threadId: v.string(), prompt: v.string() },
  returns: v.null(),
  handler: async (ctx, { threadId, prompt }) => {
    await authorizeThreadAccess(ctx, threadId, true);
    const { messageId } = await fashionAgent.saveMessage(ctx, {
      threadId,
      prompt,
      skipEmbeddings: true,
    });
    await enqueueFollowUp(ctx, threadId, messageId);
    return null;
  },
});

/** Answers a failed or stopped follow-up again, reusing its question. */
export const retryFollowUp = mutation({
  args: { threadId: v.string(), promptMessageId: v.string() },
  returns: v.null(),
  handler: async (ctx, { threadId, promptMessageId }) => {
    await authorizeThreadAccess(ctx, threadId, true);
    const [prompt] = await ctx.runQuery(
      components.agent.messages.getMessagesByIds,
      { messageIds: [promptMessageId] },
    );
    if (prompt?.threadId !== threadId || prompt.message?.role !== "user") {
      throw new Error("That question isn't in this thread");
    }
    await enqueueFollowUp(ctx, threadId, promptMessageId);
    return null;
  },
});

/**
 * Whether a question is still waiting for a free slot in the pool, so the
 * page can say so instead of looking stuck.
 */
export const followUpQueued = query({
  args: { threadId: v.string(), promptMessageId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { threadId, promptMessageId }) => {
    await authorizeThreadAccess(ctx, threadId, true);
    const job = await followUpJob(ctx, promptMessageId);
    if (job?.threadId !== threadId) return false;
    const status = await followUpPool.status(ctx, job.workId);
    return status.state === "pending";
  },
});

/** The latest answer attempt to a prompt, if there is one. */
async function latestReplyTo(
  ctx: QueryCtx,
  threadId: string,
  promptMessageId: string,
) {
  // Newest first, starting from the end of the prompt's own turn, so
  // anything listed before the prompt is a reply to it.
  const { page } = await ctx.runQuery(
    components.agent.messages.listMessagesByThreadId,
    {
      threadId,
      order: "desc",
      upToAndIncludingMessageId: promptMessageId,
      paginationOpts: { cursor: null, numItems: 10 },
    },
  );
  for (const message of page) {
    if (message._id === promptMessageId) return undefined;
    if (message.message?.role === "assistant") return message;
  }
  return undefined;
}

/**
 * Runs once per follow-up job, whether it succeeded or failed.
 *
 * The agent normally marks its own reply as failed. If the action died before
 * it could (a timeout or crash), do it here so the page offers Retry instead
 * of waiting forever.
 */
export const followUpDone = internalMutation({
  args: vOnCompleteArgs(
    v.object({ threadId: v.string(), promptMessageId: v.string() }),
  ),
  returns: v.null(),
  handler: async (ctx, { workId, context, result }) => {
    const { threadId, promptMessageId } = context;
    const job = await followUpJob(ctx, promptMessageId);
    if (job?.workId !== workId) return null;
    // Until this row goes, the question can't be asked again: whatever reply
    // or stream is there now belongs to this job, not a newer attempt.
    await ctx.db.delete("followUpJobs", job._id);
    if (result.kind !== "failed") return null;

    const [prompt] = await ctx.runQuery(
      components.agent.messages.getMessagesByIds,
      { messageIds: [promptMessageId] },
    );
    if (!prompt) return null;
    await abortStream(ctx, components.agent, {
      threadId,
      order: prompt.order,
      reason: result.error,
    });
    const reply = await latestReplyTo(ctx, threadId, promptMessageId);
    if (reply?.status === "failed" && reply.error === STOPPED_BY_USER) {
      return null;
    }
    console.error("Follow-up failed:", context, result.error);
    if (!reply) {
      await fashionAgent.saveMessage(ctx, {
        threadId,
        promptMessageId,
        message: { role: "assistant", content: "" },
        metadata: { status: "failed", error: result.error },
        skipEmbeddings: true,
      });
    } else if (reply.status === "pending") {
      await fashionAgent.finalizeMessage(ctx, {
        messageId: reply._id,
        result: { status: "failed", error: result.error },
      });
    }
    return null;
  },
});

export const streamFollowUp = fashionAgent.asTextAction({
  stream: { chunking: "word", throttleMs: 100 },
});
