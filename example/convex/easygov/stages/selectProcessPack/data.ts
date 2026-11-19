// What the selectProcessPack workflow reads and writes, and what a selection
// on the case means.
import { vWorkflowId, type WorkflowId } from "@convex-dev/workflow";
import { v } from "convex/values";
import type { Doc } from "../../../_generated/dataModel";
import { internalMutation, internalQuery } from "../../../_generated/server";
import { writeCase, type Case } from "../../case/data";
import { vStageResult, type StageResult } from "../../case/schema";
import { proposalFields, selectionAgent } from "./agent";

/** Appended instead of a pack when the request needs a lawyer, not a form. */
const REFERRAL_STEP = {
  id: "legalReferral",
  type: "legalReferral",
  params: { kind: "advice" },
};

/**
 * The selection made for the case's current goal, if there is one. One made
 * for an earlier goal is out of date, and counts as none.
 */
export function currentSelection(found: Case) {
  const selection = found.processPack;
  return selection?.goalVersion === found.intake?.version
    ? selection
    : undefined;
}

/** What a case pins of its selected pack: the saved row and its questions. */
export function processPackDefinition(pack: Doc<"processPacks">) {
  return {
    id: pack._id,
    inputs: pack.inputs,
    inputQuestions: pack.inputQuestions,
  };
}

/**
 * A rejection of the current goal. Intake reads it, and waits for a new goal:
 * nothing of intake's is cleared here.
 */
export function rejected(goalVersion: number): Case["processPack"] {
  return { status: "rejected", goalVersion };
}

// --- What the workflow reads and writes -------------------------------------

export const check = internalQuery({
  args: { caseId: v.id("cases"), backTo: v.string() },
  returns: v.union(vStageResult, v.null()),
  handler: async (ctx, { caseId, backTo }): Promise<StageResult | null> => {
    const found = await ctx.db.get("cases", caseId);
    const selection = found && currentSelection(found);
    if (selection?.status === "rejected") return { outcome: "back", backTo };
    if (selection?.status !== "confirmed") return null;
    if (selection.referral) return { outcome: "done", append: [REFERRAL_STEP] };
    // The confirmed pack's steps join the plan after this one.
    const pack =
      selection.definition &&
      (await ctx.db.get("processPacks", selection.definition.id));
    return pack
      ? { outcome: "done", append: pack.plan }
      : { outcome: "stop", reason: "No known process was confirmed" };
  },
});

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
    const { threadId, workflowId } = found;
    return { goal, goalVersion, threadId, workflowId };
  },
});

/** True until a process has been proposed or chosen for the current goal. */
export const needsProposal = internalQuery({
  args: { caseId: v.id("cases") },
  returns: v.boolean(),
  handler: async (ctx, { caseId }): Promise<boolean> => {
    const found = await ctx.db.get("cases", caseId);
    return !found || !currentSelection(found);
  },
});

/**
 * Records the proposal for the current request, and posts its message. Both
 * happen or neither does: false means nothing was kept. A choice the person
 * already made takes precedence over the delayed result.
 */
export const record = internalMutation({
  args: { caseId: v.id("cases"), ...proposalFields },
  returns: v.boolean(),
  handler: async (
    ctx,
    { caseId, message, packId, draft, referral, origin, needsClarification },
  ): Promise<boolean> => {
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
    await writeCase(ctx, "selectProcessPack", caseId, {
      processPack: needsClarification
        ? rejected(goalVersion)
        : { status: "proposed", goalVersion, definition, draft, referral },
    });
    return true;
  },
});
