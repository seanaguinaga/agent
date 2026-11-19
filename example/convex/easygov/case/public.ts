// The public API: start a case, read it, and send it events.
import { createThread, saveMessage } from "@convex-dev/agent";
import { ConvexError, v } from "convex/values";
import { components } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import { mutation, query, type QueryCtx } from "../../_generated/server";
import { getAuthUserId } from "../../utils";
import type { Input } from "../plans/decide";
import { handle } from "../plans/data";
import { vCaseDoc } from "../schema";
import { nudgeStage } from "../stages/shared";
import { writeCase } from "./data";
import { currentStageType, eventHandler, stageChats } from "../stages/registry";
import { vCaseEvent, type EventsOf } from "./schema";

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
      visits: {},
      answers: {},
      flags: [],
    });
    await handle(ctx, caseId, { type: "start" });
    return caseId;
  },
});

/**
 * Saves a chat message to the case's thread. A stage that chats (intake)
 * answers it; one that doesn't leaves it pending until one does.
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
    await writeCase(ctx, "core", caseId, {
      pendingMessageId: messageId,
      lastMessageKey: messageKey,
    });
    // Only a stage that chats is nudged. The nudge just says "look again".
    if (stageChats(currentStageType(found))) await nudgeStage(ctx, found);
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

    // Control events belong to the whole case, not to one stage: the
    // pipeline decides. One it ignores (e.g. a second click on retry, which
    // finds the failure already cleared) is refused.
    if (event.type in CONTROL_INPUTS) {
      const input = CONTROL_INPUTS[event.type as EventsOf<"core">];
      const decision = await handle(ctx, caseId, input);
      if (decision.type === "ignore") throw new ConvexError(decision.why);
      return null;
    }

    // Everything else goes to the stage that owns the event, if the current
    // step's stage takes it and hasn't failed. The handler says what to
    // write, as the owner; the nudge makes the running stage's workflow look.
    // If the stage hasn't started yet there is nothing to nudge, and it reads
    // what was written when it does.
    const handler = eventHandler(currentStageType(found), event.type);
    if (!handler || found.failure) {
      throw new ConvexError(`"${event.type}" isn't expected right now.`);
    }
    const patch = await handler.handle(found, event, ctx);
    await writeCase(ctx, handler.owner, caseId, patch);
    await nudgeStage(ctx, found);
    return null;
  },
});

/** The pipeline input each "core" event stands for. */
const CONTROL_INPUTS: Record<EventsOf<"core">, Input> = {
  "case.cancel": { type: "cancel" },
  "step.retry": { type: "retry" },
  "step.cancel": { type: "giveUp" },
};

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
