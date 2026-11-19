// The public API: start a case, read it, chat, and send it events.
import { createThread, saveMessage } from "@convex-dev/agent";
import { ConvexError, v } from "convex/values";
import { components, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../../_generated/server";
import { getAuthUserId } from "../../utils";
import { vCaseDoc } from "../schema";
import { endCase, logEvent, writeCase } from "./data";
import { EVENTS } from "./events";
import { vCaseEvent, vWaitingFor, type CaseEvent } from "./schema";
import { waitingFor, type Case } from "./state";
import { nudgeCase, workflow } from "./workflow";

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
      answers: {},
    });
    const workflowId = await workflow.start(
      ctx,
      internal.easygov.case.workflow.run,
      { caseId },
      {
        onComplete: internal.easygov.case.data.workflowDone,
        context: { caseId },
        // Not inline: a run that fails at once would report back before the
        // case knows its workflow id, and be ignored.
        startAsync: true,
      },
    );
    await writeCase(ctx, caseId, { workflowId });
    await logEvent(ctx, caseId, "case.started");
    return caseId;
  },
});

/** The case, and what it waits for a person to do. */
export const getCase = query({
  args: { caseId: v.id("cases") },
  returns: v.object({ ...vCaseDoc.fields, waitingFor: vWaitingFor }),
  handler: async (ctx, { caseId }) => {
    const found = await authorizeCase(ctx, caseId);
    return { ...found, waitingFor: waitingFor(found) };
  },
});

/**
 * Saves a chat message to the case's thread. Intake answers it; at any other
 * time it stays pending until intake runs again.
 *
 * `messageKey` is a string the client makes up once per message (a UUID,
 * say) and sends again on a retry. The same key twice in a row is the same
 * message, and is saved once.
 */
export const sendMessage = mutation({
  args: { caseId: v.id("cases"), text: v.string(), messageKey: v.string() },
  returns: v.null(),
  handler: async (ctx, { caseId, text, messageKey }) => {
    const found = await authorizeCase(ctx, caseId);
    if (found.status !== "active") {
      throw new ConvexError(`The case is ${found.status}.`);
    }
    const prompt = text.trim();
    if (!prompt) throw new ConvexError("Type a message first.");
    if (!messageKey) throw new ConvexError("The message needs a key.");
    if (found.lastMessageKey === messageKey) return null;
    const { messageId } = await saveMessage(ctx, components.agent, {
      threadId: found.threadId,
      userId: found.userId,
      prompt,
    });
    await writeCase(ctx, caseId, {
      pendingMessageId: messageId,
      lastMessageKey: messageKey,
    });
    await nudgeCase(ctx, found);
    return null;
  },
});

/**
 * Sends an event to a case. `expectedSeq` is the `seq` the sender last saw,
 * so an event based on a stale view of the case is refused.
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
    switch (event.type) {
      case "case.cancel":
        return await cancel(ctx, found);
      case "step.retry":
        return await retry(ctx, found);
      case "step.cancel":
        if (!found.failure) throw new ConvexError("Nothing has failed.");
        await endCase(ctx, found, "stopped", "Stopped after a failure");
        return null;
      default:
        return await personEvent(ctx, found, event);
    }
  },
});

/** Writes what the event's handler returns, then tells the workflow. */
async function personEvent(
  ctx: MutationCtx,
  c: Case,
  event: Exclude<
    CaseEvent,
    { type: "step.retry" | "step.cancel" | "case.cancel" }
  >,
): Promise<null> {
  const { during, handle } = EVENTS[event.type] as {
    during: ReturnType<typeof waitingFor>[];
    handle: (
      ctx: MutationCtx,
      c: Case,
      event: CaseEvent,
    ) => Partial<Case> | Promise<Partial<Case>>;
  };
  if (!during.includes(waitingFor(c))) {
    throw new ConvexError(`"${event.type}" isn't expected right now.`);
  }
  await writeCase(ctx, c._id, await handle(ctx, c, event));
  await nudgeCase(ctx, c);
  return null;
}

/**
 * Runs the failed workflow again from the top. Nothing it needs lives only
 * in its history, so it picks up where the case is.
 */
async function retry(ctx: MutationCtx, c: Case): Promise<null> {
  if (!c.failure) throw new ConvexError("Nothing has failed.");
  const { workflowId } = c.failure;
  await workflow.restart(ctx, workflowId, { from: 0 });
  await writeCase(ctx, c._id, { workflowId, failure: undefined });
  await logEvent(ctx, c._id, "case.retried");
  return null;
}

/** Ends the case, and stops its workflow if one is running. */
async function cancel(ctx: MutationCtx, c: Case): Promise<null> {
  // A failed workflow isn't running, and can't be canceled.
  if (c.workflowId) await workflow.cancel(ctx, c.workflowId);
  await endCase(ctx, c, "canceled", "Canceled by the user");
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
): Promise<Case> {
  const userId = await requireUser(ctx);
  const found = await ctx.db.get("cases", caseId);
  if (!found || found.userId !== userId) {
    throw new ConvexError("Case not found.");
  }
  return found;
}
