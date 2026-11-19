// What the case workflow reads and writes, and how a run reports back. Each
// query here reads the case and says whether a phase is done; the case in the
// table is the truth, so a restarted workflow picks up where the case is.
import {
  vResultValidator,
  vWorkflowId,
  type WorkflowId,
} from "@convex-dev/workflow";
import { v } from "convex/values";
import type { Doc, Id } from "../../_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "../../_generated/server";
import { intakeAgent, proposalFields, selectionAgent } from "./agents";
import { fingerprint, missingInputs } from "./answers";
import {
  currentSelection,
  newGoal,
  requiredInputs,
  reviewOutcome,
  standingGoal,
  type Case,
} from "./state";

// --- Writing a case ---------------------------------------------------------

/** The one way to change a case. It bumps `seq`, so a stale `send` is refused. */
export async function writeCase(
  ctx: MutationCtx,
  caseId: Id<"cases">,
  patch: Partial<Case>,
): Promise<void> {
  const found = await ctx.db.get("cases", caseId);
  if (!found) throw new Error(`No case ${caseId}`);
  await ctx.db.patch("cases", caseId, { ...patch, seq: found.seq + 1 });
}

/** Appends to `caseEvents`, the history of a case. */
export async function logEvent(
  ctx: MutationCtx,
  caseId: Id<"cases">,
  kind: string,
  detail?: string,
): Promise<void> {
  await ctx.db.insert("caseEvents", { caseId, kind, detail });
}

/** Ends a case. Only "done" is success; every other status has a reason. */
export async function endCase(
  ctx: MutationCtx,
  c: Case,
  status: Exclude<Case["status"], "active">,
  endReason?: string,
): Promise<void> {
  await writeCase(ctx, c._id, {
    status,
    endReason,
    workflowId: undefined,
    failure: undefined,
  });
  await logEvent(ctx, c._id, `case.${status}`, endReason);
}

/** What a case pins of the pack it chose: the saved row and its questions. */
export function processPackDefinition(pack: Doc<"processPacks">) {
  return {
    id: pack._id,
    inputs: pack.inputs,
    inputQuestions: pack.inputQuestions,
  };
}

// --- 1. Intake --------------------------------------------------------------

/** Done once there's a goal; otherwise the message to answer, or null to wait. */
export const intakeNext = internalQuery({
  args: { caseId: v.id("cases") },
  returns: v.union(
    v.object({ kind: v.literal("done") }),
    v.object({ kind: v.literal("message"), promptMessageId: v.string() }),
    v.null(),
  ),
  handler: async (ctx, { caseId }) => {
    const found = await ctx.db.get("cases", caseId);
    if (!found || standingGoal(found)) return { kind: "done" as const };
    const promptMessageId = found.pendingMessageId;
    return promptMessageId
      ? { kind: "message" as const, promptMessageId }
      : null;
  },
});

export const threadOf = internalQuery({
  args: { caseId: v.id("cases") },
  returns: v.object({ threadId: v.string() }),
  handler: async (ctx, { caseId }) => {
    const found = await ctx.db.get("cases", caseId);
    if (!found) throw new Error("Case not found");
    return { threadId: found.threadId };
  },
});

/** Keeps an intake turn: posts the reply, and records the goal if it found one. */
export const recordTurn = internalMutation({
  args: {
    caseId: v.id("cases"),
    promptMessageId: v.string(),
    reply: v.string(),
    goal: v.union(v.string(), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, { caseId, promptMessageId, reply, goal }) => {
    const found = await ctx.db.get("cases", caseId);
    if (!found || found.status !== "active") return null;
    await intakeAgent.saveMessage(ctx, {
      threadId: found.threadId,
      promptMessageId,
      message: { role: "assistant", content: reply },
      skipEmbeddings: true,
    });
    const patch: Partial<Case> = {};
    // A newer message stays pending, for the next turn.
    if (found.pendingMessageId === promptMessageId) {
      patch.pendingMessageId = undefined;
    }
    const goalText = goal?.trim();
    if (goalText) patch.intake = newGoal(found, goalText);
    await writeCase(ctx, caseId, patch);
    return null;
  },
});

// --- 2. Choosing a process pack ---------------------------------------------

export const goalOf = internalQuery({
  args: { caseId: v.id("cases") },
  returns: v.object({
    goal: v.string(),
    goalVersion: v.number(),
    threadId: v.string(),
    workflowId: vWorkflowId,
  }),
  handler: async (
    ctx,
    { caseId },
  ): Promise<{
    goal: string;
    goalVersion: number;
    threadId: string;
    workflowId: WorkflowId;
  }> => {
    const found = await ctx.db.get("cases", caseId);
    if (!found?.intake || !found.workflowId)
      throw new Error("The case has no goal or running workflow");
    const { goal, version: goalVersion } = found.intake;
    return {
      goal,
      goalVersion,
      threadId: found.threadId,
      workflowId: found.workflowId,
    };
  },
});

/** True until a pack has been proposed or chosen for the current goal. */
export const needsProposal = internalQuery({
  args: { caseId: v.id("cases") },
  returns: v.boolean(),
  handler: async (ctx, { caseId }) => {
    const found = await ctx.db.get("cases", caseId);
    return !!found && !currentSelection(found);
  },
});

/**
 * Records the proposal and posts its message: both or neither, and false
 * means nothing was kept. A choice the person already made, or a newer goal,
 * wins over this result.
 */
export const recordProposal = internalMutation({
  args: { caseId: v.id("cases"), ...proposalFields },
  returns: v.boolean(),
  handler: async (
    ctx,
    { caseId, message, packId, draft, referral, origin, needsClarification },
  ) => {
    const found = await ctx.db.get("cases", caseId);
    if (!found || found.status !== "active") return false;
    if (currentSelection(found)) return true;
    const { goalVersion } = origin;
    if (
      found.workflowId !== origin.workflowId ||
      found.intake?.version !== goalVersion
    )
      return false;
    const stored = packId ? await ctx.db.get("processPacks", packId) : null;
    const definition =
      stored &&
      (stored.ownerId === undefined || stored.ownerId === found.userId)
        ? processPackDefinition(stored)
        : undefined;
    // Nothing usable (e.g. a pack this person can't see): say nothing, so
    // the thread never announces a proposal the case doesn't have.
    if (!needsClarification && !referral && !draft && !definition) return false;
    await selectionAgent.saveMessage(ctx, {
      threadId: found.threadId,
      message: { role: "assistant", content: message },
      skipEmbeddings: true,
    });
    // A question for the person sends the case back to intake, like a
    // rejection: the goal as it stands can't be matched.
    await writeCase(ctx, caseId, {
      processPack: needsClarification
        ? { status: "rejected", goalVersion }
        : { status: "proposed", goalVersion, definition, draft, referral },
    });
    await logEvent(ctx, caseId, "pack.proposed", message);
    return true;
  },
});

/** "confirmed" or "rejected" once the person decides; null to wait. */
export const packDecision = internalQuery({
  args: { caseId: v.id("cases") },
  returns: v.union(v.literal("confirmed"), v.literal("rejected"), v.null()),
  handler: async (ctx, { caseId }) => {
    const found = await ctx.db.get("cases", caseId);
    const status = found && currentSelection(found)?.status;
    return status === "confirmed" || status === "rejected" ? status : null;
  },
});

/** True when the person confirmed a legal referral rather than a pack. */
export const isReferral = internalQuery({
  args: { caseId: v.id("cases") },
  returns: v.boolean(),
  handler: async (ctx, { caseId }) => {
    const found = await ctx.db.get("cases", caseId);
    return !!(found && currentSelection(found)?.referral);
  },
});

// --- 3. Answers, the document, and review -----------------------------------

/** True once every input the pack asks for has an answer. */
export const answersComplete = internalQuery({
  args: { caseId: v.id("cases") },
  returns: v.union(v.literal(true), v.null()),
  handler: async (ctx, { caseId }) => {
    const found = await ctx.db.get("cases", caseId);
    const inputs = found && requiredInputs(found);
    if (!found || !inputs) throw new Error("The case has no confirmed pack");
    return missingInputs(inputs, found.answers).length === 0 ? true : null;
  },
});

/** Builds the document from the current answers. A stand-in for PDF filling. */
export const fill = internalMutation({
  args: { caseId: v.id("cases") },
  returns: v.null(),
  handler: async (ctx, { caseId }) => {
    const found = await ctx.db.get("cases", caseId);
    if (!found) return null;
    const packId = currentSelection(found)?.definition?.id;
    const pack = packId ? await ctx.db.get("processPacks", packId) : null;
    const summary = JSON.stringify({
      process: pack?.title,
      answers: found.answers,
      output: pack?.output,
    });
    await writeCase(ctx, caseId, {
      artifact: { summary, fingerprint: fingerprint(found.answers) },
    });
    await logEvent(ctx, caseId, "document.filled");
    return null;
  },
});

/** "approved", or "changed" when an answer was edited in review; null to wait. */
export const reviewResult = internalQuery({
  args: { caseId: v.id("cases") },
  returns: v.union(v.literal("approved"), v.literal("changed"), v.null()),
  handler: async (ctx, { caseId }) => {
    const found = await ctx.db.get("cases", caseId);
    return found ? reviewOutcome(found) : "changed";
  },
});

// --- 4. The end -------------------------------------------------------------

/**
 * Finishes the case: opens a referral if one applies, prepares delivery if
 * the pack has a channel, and marks it done. Safe to run twice.
 */
export const finish = internalMutation({
  args: { caseId: v.id("cases") },
  returns: v.null(),
  handler: async (ctx, { caseId }) => {
    const found = await ctx.db.get("cases", caseId);
    if (!found || found.status !== "active") return null;
    const selection = currentSelection(found);
    const pack = selection?.definition
      ? await ctx.db.get("processPacks", selection.definition.id)
      : null;
    const referral = selection?.referral
      ? "advice"
      : pack?.referral &&
          (!pack.referral.when ||
            found.answers[pack.referral.when.input] ===
              pack.referral.when.equals)
        ? pack.referral.kind
        : undefined;
    if (referral) await openReferral(ctx, found, referral);
    if (pack?.delivery) {
      await writeCase(ctx, caseId, {
        delivery: { status: "prepared", channel: pack.delivery },
      });
    }
    await endCase(ctx, found, "done");
    return null;
  },
});

/** Stops the case with a reason, e.g. when a loop ran out of tries. */
export const stop = internalMutation({
  args: { caseId: v.id("cases"), reason: v.string() },
  returns: v.null(),
  handler: async (ctx, { caseId, reason }) => {
    const found = await ctx.db.get("cases", caseId);
    if (found?.status === "active")
      await endCase(ctx, found, "stopped", reason);
    return null;
  },
});

/** One referral per kind: a retried finish doesn't open a second. */
async function openReferral(ctx: MutationCtx, c: Case, kind: string) {
  const existing = await ctx.db
    .query("referrals")
    .withIndex("by_caseId_and_kind", (q) =>
      q.eq("caseId", c._id).eq("kind", kind),
    )
    .first();
  if (existing) return;
  await ctx.db.insert("referrals", {
    caseId: c._id,
    userId: c.userId,
    kind,
    status: "open",
  });
  await logEvent(ctx, c._id, "referral.opened", kind);
}

/**
 * The workflow's `onComplete`, after every run. A failure parks the case: it
 * keeps the workflow id for a retry, and clears `workflowId` so nothing
 * nudges or cancels a workflow that isn't running. A finished run has already
 * ended the case, and a canceled one was canceled by ending it.
 */
export const workflowDone = internalMutation({
  args: {
    workflowId: vWorkflowId,
    result: vResultValidator,
    context: v.object({ caseId: v.id("cases") }),
  },
  returns: v.null(),
  handler: async (ctx, { workflowId, result, context }) => {
    const found = await ctx.db.get("cases", context.caseId);
    if (!found || found.workflowId !== workflowId) return null;
    if (result.kind === "failed") {
      await writeCase(ctx, found._id, {
        failure: { error: result.error, workflowId },
        workflowId: undefined,
      });
      await logEvent(ctx, found._id, "case.failed", result.error);
    } else if (found.status === "active") {
      // A run that ended without ending its case is a bug: say so.
      await endCase(ctx, found, "stopped", "The workflow ended early");
    }
    return null;
  },
});
