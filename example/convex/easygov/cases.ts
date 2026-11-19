// The public API: start a case, read it, and send it events.
import { createThread, saveMessage } from "@convex-dev/agent";
import { ConvexError, v } from "convex/values";
import { components, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { getAuthUserId } from "../utils";
import { endCase, logEvent, recoveryEvent } from "./pipeline";
import { vCaseDoc } from "./schema";
import { stageEvent, workflow } from "./stage";
import { eventHandler } from "./stages/stages.registry";
import { vCaseEvent } from "./validators";

export const startCase = mutation({
  args: {},
  returns: v.id("cases"),
  handler: async (ctx): Promise<Id<"cases">> => {
    const userId = await requireUser(ctx);
    const threadId = await createThread(ctx, components.agent, {
      userId,
      title: "easygov case",
    });
    const caseId = await ctx.db.insert("cases", {
      userId,
      threadId,
      status: "active",
      seq: 0,
      plan: [],
      stepStatus: {},
      appended: 0,
      answers: {},
      flags: [],
    });
    const parentWorkflowId = await workflow.start(
      ctx,
      internal.easygov.pipeline.govCase,
      { caseId },
      {
        onComplete: internal.easygov.pipeline.caseDone,
        context: { caseId },
      },
    );
    await ctx.db.patch("cases", caseId, { parentWorkflowId });
    return caseId;
  },
});

/**
 * Saves a chat message to the case's thread. The intake stage answers it;
 * a stage that isn't listening leaves it pending until one is.
 */
export const sendMessage = mutation({
  args: { caseId: v.id("cases"), text: v.string() },
  returns: v.null(),
  handler: async (ctx, { caseId, text }) => {
    const found = await authorizeCase(ctx, caseId);
    if (found.status !== "active") {
      throw new ConvexError(`The case is ${found.status}.`);
    }
    const prompt = text.trim();
    if (!prompt) throw new ConvexError("Type a message first.");
    const { messageId } = await saveMessage(ctx, components.agent, {
      threadId: found.threadId,
      userId: found.userId,
      prompt,
    });
    await ctx.db.patch("cases", caseId, { pendingMessageId: messageId });
    // Only intake chats for now. The nudge just says "look again".
    if (found.stage === "intake" && found.activeWorkflowId) {
      await workflow.sendEvent(ctx, {
        ...stageEvent,
        workflowId: found.activeWorkflowId,
        value: null,
      });
    }
    return null;
  },
});

export const getCase = query({
  args: { caseId: v.id("cases") },
  returns: vCaseDoc,
  handler: async (ctx, { caseId }) => await authorizeCase(ctx, caseId),
});

/**
 * Sends an event to a case. `expectedSeq` is the `seq` the sender last saw,
 * so an event based on a stale view of the case is rejected.
 */
export const send = mutation({
  args: { caseId: v.id("cases"), event: vCaseEvent, expectedSeq: v.number() },
  returns: v.null(),
  handler: async (ctx, { caseId, event, expectedSeq }) => {
    const found = await authorizeCase(ctx, caseId);
    if (found.seq !== expectedSeq) {
      throw new ConvexError("The case has changed. Reload and try again.");
    }
    if (found.status !== "active") {
      throw new ConvexError(`The case is ${found.status}.`);
    }

    // Control events belong to the whole case, not to one stage.
    if (event.type === "case.cancel") return await cancelCase(ctx, found);
    if (event.type === "step.retry" || event.type === "step.cancel") {
      return await recoverStep(ctx, found, event.type);
    }

    // Everything else goes to the active stage, if it takes this event. The
    // handler says what to write; the stage's workflow notices on its own.
    const handle = eventHandler(found.stage, event.type);
    const stepIsActive =
      found.stepStatus[found.activeStepId ?? ""]?.status === "active";
    if (!handle || !stepIsActive) {
      throw new ConvexError(`"${event.type}" isn't expected right now.`);
    }
    if (!found.activeWorkflowId) {
      throw new ConvexError("The case is between steps. Try again shortly.");
    }
    await ctx.db.patch("cases", caseId, {
      ...handle(found, event),
      seq: found.seq + 1,
    });
    await workflow.sendEvent(ctx, {
      ...stageEvent,
      workflowId: found.activeWorkflowId,
      value: null,
    });
    return null;
  },
});

/** Cancels the parent workflow, which also cancels the stage it's running. */
async function cancelCase(ctx: MutationCtx, found: Doc<"cases">) {
  if (found.parentWorkflowId) {
    await workflow.cancel(ctx, found.parentWorkflowId);
  }
  await endCase(ctx, found, "canceled", "Canceled by the user");
  return null;
}

/** Tells the parent to retry or give up on the step that failed. */
async function recoverStep(
  ctx: MutationCtx,
  found: Doc<"cases">,
  type: "step.retry" | "step.cancel",
) {
  const stepId = found.activeStepId;
  const step = stepId ? found.stepStatus[stepId] : undefined;
  if (!stepId || !step || step.status !== "failed" || !found.parentWorkflowId) {
    throw new ConvexError("No failed step to recover.");
  }
  // "recovering" stops a double click from queueing a second event.
  await ctx.db.patch("cases", found._id, {
    stepStatus: {
      ...found.stepStatus,
      [stepId]: { ...step, status: "recovering" },
    },
    seq: found.seq + 1,
  });
  await workflow.sendEvent(ctx, {
    ...recoveryEvent,
    workflowId: found.parentWorkflowId,
    value: { kind: type === "step.retry" ? "retry" : "cancel" },
  });
  await logEvent(ctx, found._id, type, stepId);
  return null;
}

// --- Who may touch a case ---------------------------------------------------

async function requireUser(ctx: QueryCtx): Promise<string> {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new ConvexError("Sign in first.");
  return userId;
}

/** The case, if it belongs to the signed-in user. */
async function authorizeCase(
  ctx: QueryCtx,
  caseId: Id<"cases">,
): Promise<Doc<"cases">> {
  const userId = await requireUser(ctx);
  const found = await ctx.db.get("cases", caseId);
  if (!found || found.userId !== userId) {
    throw new ConvexError("Case not found.");
  }
  return found;
}
