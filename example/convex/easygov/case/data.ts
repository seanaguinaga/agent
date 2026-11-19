// What the case workflow reads and writes, and how a run reports back. Each
// query here reads the case and says whether a phase is done; the case in the
// table is the truth, so a restarted workflow picks up where the case is.
import {
  vResultValidator,
  vWorkflowId,
  type WorkflowId,
} from "@convex-dev/workflow";
import { listMessages } from "@convex-dev/agent";
import { v, type Infer } from "convex/values";
import { components } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "../../_generated/server";
import type { vProcessPackDefinition } from "../packs/schema";
import { vFilledDocument } from "./schema";
import { intakeAgent, proposalFields, selectionAgent } from "./agents";
import { missingInputs, renderLetter } from "./answers";
import { rememberedElsewhere } from "../profile/data";
import { isReading, READINGS } from "../profile/vocabulary";
import { answerKind, readingConversation } from "./state";
import {
  currentChoice,
  currentSelection,
  fingerprintOf,
  missingDocuments,
  newGoal,
  pinnedPack,
  requiredInputs,
  reviewOutcome,
  standingGoal,
  type Case,
} from "./state";

type Draft = Infer<typeof vProcessPackDefinition>;

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
export async function logCaseEvent(
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
  await logCaseEvent(ctx, c._id, `case.${status}`, endReason);
}

/**
 * What a case pins of the pack it chose: the saved row, and the parts that
 * say what the case waits for.
 */
export function processPackDefinition(pack: Doc<"processPacks">) {
  return {
    id: pack._id,
    inputs: pack.inputs,
    inputQuestions: pack.inputQuestions,
    documents: pack.documents,
    deadline: pack.deadline,
    referral: pack.referral,
    profile: pack.profile,
    form: pack.form,
  };
}

/** What a case pins of a draft it confirmed: there's no saved row. */
export function draftDefinition(draft: Draft) {
  const { inputs, inputQuestions, documents, deadline, referral, profile } =
    draft;
  // A draft never fills a form: a form's mapping is reviewed by a person.
  return { inputs, inputQuestions, documents, deadline, referral, profile };
}

/** What the case runs on: the saved pack it pinned, or its confirmed draft. */
async function packOf(
  ctx: QueryCtx,
  c: Case,
): Promise<Doc<"processPacks"> | Draft | null> {
  const selection = currentChoice(c);
  const id = selection?.definition?.id;
  return id ? await ctx.db.get("processPacks", id) : (selection?.draft ?? null);
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
    if (goalText) await logCaseEvent(ctx, caseId, "goal.set", goalText);
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
    {
      caseId,
      message,
      packId,
      draft,
      referral,
      jurisdiction,
      origin,
      needsClarification,
      research,
    },
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
        : {
            status: "proposed",
            goalVersion,
            definition,
            draft,
            research: draft ? research : undefined,
            referral,
            jurisdiction: referral ? jurisdiction : undefined,
          },
    });
    // A question isn't a proposal: the history says which one this was.
    await logCaseEvent(
      ctx,
      caseId,
      needsClarification ? "pack.clarification" : "pack.proposed",
      message,
    );
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
    return !!(found && currentChoice(found)?.referral);
  },
});

// --- Prefill ----------------------------------------------------------------

/**
 * What prefill reads: the confirmed pack's unanswered questions, and
 * everything the person has said, in chat and as their goal.
 */
export const prefillInput = internalQuery({
  args: { caseId: v.id("cases") },
  returns: v.object({
    goalVersion: v.number(),
    threadId: v.string(),
    questions: v.array(
      v.object({
        key: v.string(),
        question: v.string(),
        kind: v.optional(v.union(v.literal("date"), v.literal("number"))),
      }),
    ),
    said: v.array(v.string()),
  }),
  handler: async (ctx, { caseId }) => {
    const found = await ctx.db.get("cases", caseId);
    if (!found?.intake) throw new Error("The case has no goal");
    const pack = pinnedPack(found);
    const asked = new Map(
      (pack?.inputQuestions ?? []).map(({ key, question }) => [key, question]),
    );
    const questions = (pack?.inputs ?? [])
      .filter((key) => found.answers[key] === undefined)
      .map((key) => ({
        key,
        // A profile reading is asked for by what it is.
        question:
          asked.get(key) ?? (isReading(key) ? READINGS[key].label : key),
        kind: answerKind(found, key),
      }));
    const { page } = await listMessages(ctx, components.agent, {
      threadId: found.threadId,
      paginationOpts: { cursor: null, numItems: 50 },
    });
    const said = page
      .reverse()
      .filter((message) => message.message?.role === "user" && message.text)
      .map((message) => message.text!);
    // The goal is the person's too: a proposal only follows a stated one.
    said.push(found.intake.goal);
    // So is what they answered on earlier forms: a similar question here
    // may already be answered. Offered back, never filled in.
    for (const { question, answer } of await rememberedElsewhere(ctx, found)) {
      said.push(
        `On an earlier form, asked "${question}", I answered: ${answer}`,
      );
    }
    return {
      goalVersion: found.intake.version,
      threadId: found.threadId,
      questions,
      said,
    };
  },
});

/** True while the conversation is still to be read for answers. */
export const needsPrefill = internalQuery({
  args: { caseId: v.id("cases") },
  returns: v.boolean(),
  handler: async (ctx, { caseId }) => {
    const found = await ctx.db.get("cases", caseId);
    return !!found && found.status === "active" && readingConversation(found);
  },
});

/**
 * Keeps what prefill found, as suggestions: the person still has to accept
 * them. Recorded even when empty: that's what lets the case ask for answers.
 */
export const recordPrefill = internalMutation({
  args: {
    caseId: v.id("cases"),
    goalVersion: v.number(),
    answers: v.record(v.string(), v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { caseId, goalVersion, answers }) => {
    const found = await ctx.db.get("cases", caseId);
    // Once, and only for the goal it was read for.
    if (
      !found ||
      found.status !== "active" ||
      found.intake?.version !== goalVersion ||
      !readingConversation(found)
    ) {
      return null;
    }
    await writeCase(ctx, caseId, { suggested: { goalVersion, answers } });
    const keys = Object.keys(answers);
    if (keys.length) {
      await logCaseEvent(ctx, caseId, "answers.suggested", keys.join(", "));
    }
    return null;
  },
});

// --- 3. Answers, the document, and review -----------------------------------

/** True once every answer and required file the pack asks for is in. */
export const answersComplete = internalQuery({
  args: { caseId: v.id("cases") },
  returns: v.union(v.literal(true), v.null()),
  handler: async (ctx, { caseId }) => {
    const found = await ctx.db.get("cases", caseId);
    const inputs = found && requiredInputs(found);
    if (!found || !inputs) throw new Error("The case has no confirmed pack");
    const missing =
      missingInputs(inputs, found.answers, found.fromProfile).length +
      missingDocuments(found).length;
    return missing === 0 ? true : null;
  },
});

/** The answers to the questions the pack's checklist is tailored by. */
function situationOf(c: Case, pack: Awaited<ReturnType<typeof packOf>>) {
  const asked = new Map(
    (pinnedPack(c)?.inputQuestions ?? []).map(({ key, question }) => [
      key,
      question,
    ]),
  );
  return (pack?.output?.tailorBy ?? [])
    .filter((key) => c.answers[key])
    .map((key) => ({
      question: asked.get(key) ?? key,
      answer: c.answers[key],
    }));
}

/** True when the pack's checklist is tailored by answers the person gave. */
export const needsTailoring = internalQuery({
  args: { caseId: v.id("cases") },
  returns: v.boolean(),
  handler: async (ctx, { caseId }) => {
    const found = await ctx.db.get("cases", caseId);
    if (!found) return false;
    const pack = await packOf(ctx, found);
    return (
      !!pack?.output?.checklist.length && situationOf(found, pack).length > 0
    );
  },
});

/** What tailoring reads: the checklist, and the person's situation. */
export const tailorInput = internalQuery({
  args: { caseId: v.id("cases") },
  returns: v.object({
    threadId: v.string(),
    fingerprint: v.string(),
    checklist: v.array(v.string()),
    situation: v.array(v.object({ question: v.string(), answer: v.string() })),
  }),
  handler: async (ctx, { caseId }) => {
    const found = await ctx.db.get("cases", caseId);
    if (!found) throw new Error("Case not found");
    const pack = await packOf(ctx, found);
    return {
      threadId: found.threadId,
      fingerprint: fingerprintOf(found),
      checklist: pack?.output?.checklist ?? [],
      situation: situationOf(found, pack),
    };
  },
});

/**
 * Builds the document from the current answers, and the pack's letter if it
 * has one. A stand-in for PDF filling.
 *
 * With `tailored`, the checklist is cut to the steps that apply to the
 * person. It was chosen for the answers as they stood (`fingerprint`): if
 * they've changed since, the document is out of date on its own, and the
 * workflow goes around again.
 */
export const fill = internalMutation({
  args: {
    caseId: v.id("cases"),
    tailored: v.optional(
      v.object({ fingerprint: v.string(), keep: v.array(v.number()) }),
    ),
    /** The official form, filled in, when the pack fills one. */
    document: v.optional(vFilledDocument),
  },
  returns: v.null(),
  handler: async (ctx, { caseId, tailored, document }) => {
    const found = await ctx.db.get("cases", caseId);
    if (!found) return null;
    const pack = await packOf(ctx, found);
    const steps = pack?.output?.checklist ?? [];
    // Only the pack's own steps, in its order.
    const checklist = tailored
      ? steps.filter((_, i) => tailored.keep.includes(i + 1))
      : undefined;
    const summary = JSON.stringify({
      process: pack?.title,
      answers: found.answers,
      output: pack?.output,
      checklist,
    });
    const letter = pack?.output?.letter;
    await writeCase(ctx, caseId, {
      artifact: {
        summary,
        letter: letter ? renderLetter(letter, found.answers) : undefined,
        checklist,
        document,
        fingerprint: tailored?.fingerprint ?? fingerprintOf(found),
      },
    });
    await logCaseEvent(
      ctx,
      caseId,
      "document.filled",
      checklist
        ? `${checklist.length} of ${steps.length} steps apply`
        : undefined,
    );
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
 * True once no referral is waiting on the person: none was offered, or they
 * shared the case or declined.
 */
export const referralSettled = internalQuery({
  args: { caseId: v.id("cases") },
  returns: v.union(v.literal(true), v.null()),
  handler: async (ctx, { caseId }) => {
    const found = await ctx.db.get("cases", caseId);
    return found?.referral?.status === "offered" ? null : true;
  },
});

/**
 * Finishes the case: prepares delivery if the pack has a channel, and marks
 * it done. Safe to run twice.
 */
export const finish = internalMutation({
  args: { caseId: v.id("cases") },
  returns: v.null(),
  handler: async (ctx, { caseId }) => {
    const found = await ctx.db.get("cases", caseId);
    if (!found || found.status !== "active") return null;
    const pack = await packOf(ctx, found);
    if (pack?.delivery) {
      await writeCase(ctx, caseId, {
        delivery: { status: "prepared", channel: pack.delivery },
      });
    }
    // What the case changed about the person is offered to their profile,
    // for them to confirm: the new address becomes the home address.
    for (const { input, updates } of pinnedPack(found)?.profile ?? []) {
      const text = updates && found.answers[input];
      if (!text) continue;
      await ctx.db.insert("profileProposals", {
        userId: found.userId,
        fact: updates,
        text,
        caseId,
        status: "open",
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
      await logCaseEvent(ctx, found._id, "case.failed", result.error);
    } else if (found.status === "active") {
      // A run that ended without ending its case is a bug: say so.
      await endCase(ctx, found, "stopped", "The workflow ended early");
    }
    return null;
  },
});
