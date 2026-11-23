import { vPacketForm } from "../packs/schema";
// What the case's workflows read and write. Each query here reads the case
// and says whether a phase is done; the case in the table is the truth, so
// work started again picks up where the case is.
import { vWorkflowId, type WorkflowId } from "@convex-dev/workflow";
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
import { vProcessPackDefinition } from "../packs/schema";
import {
  definitionOf,
  vFoundFacts,
  draftOf,
  type Evidence,
  type HistoryKind,
} from "./schema";
import { vPacketPdf, vFilledDocument, vReadStatus } from "../forms/schema";
import { intakeAgent, proposalFields } from "./agents";
import { selectionAgent } from "./selection";
import { stalenessOf } from "../packs/freshness";
import { renderLetter } from "./answers";
import { offerFact, syncCase, rememberedElsewhere } from "../profile/data";
import {
  answerKind,
  questionOf,
  isSuggesting,
  needsRevisit,
  unbackedForms,
  editionCheck,
} from "./state";
import {
  caseEvidence,
  currentChoice,
  currentSelection,
  fingerprintOf,
  missing,
  missingEvidence,
  newGoal,
  pinnedPack,
  activeForms,
  routeApplies,
  type Case,
} from "./state";

type Draft = Infer<typeof vProcessPackDefinition>;

// --- Writing a case ---------------------------------------------------------

/** The one way to change a case. It bumps `seq`, so a stale `sendEvent` is refused. */
export async function writeCase(
  ctx: MutationCtx,
  caseId: Id<"cases">,
  patch: Partial<Case>,
): Promise<void> {
  const found = await ctx.db.get("cases", caseId);
  if (!found) throw new Error(`No case ${caseId}`);
  await ctx.db.patch("cases", caseId, { ...patch, seq: found.seq + 1 });
}

/**
 * Says what the case's running work is doing with a scanned form: its
 * latest status, one for each form. Nobody hears it once the work is over.
 */
export const noteReading = internalMutation({
  args: { caseId: v.id("cases"), code: v.string(), status: vReadStatus },
  returns: v.null(),
  handler: async (ctx, { caseId, ...now }) => {
    const found = await ctx.db.get("cases", caseId);
    if (found?.run?.state !== "running") return null;
    const others = found.run.reading?.filter(({ code }) => code !== now.code);
    const reading = [...(others ?? []), now];
    await writeCase(ctx, caseId, { run: { ...found.run, reading } });
    return null;
  },
});

/** Appends to `caseEvents`, the history of a case. */
export async function logCaseEvent(
  ctx: MutationCtx,
  caseId: Id<"cases">,
  kind: HistoryKind,
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
    run: undefined,
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
    evidence: pack.evidence,
    deadline: pack.deadline,
    referral: pack.referral,
    profile: pack.profile,
    form: pack.form,
    letterRoute: pack.letterRoute,
    packetForms: pack.packetForms,
    eligibility: pack.eligibility,
  };
}

/** What a case pins of a draft it accepted: there's no saved row. */
export function draftDefinition(draft: Draft) {
  const { inputs, inputQuestions, evidence, deadline, referral, profile } =
    draft;
  return {
    inputs,
    inputQuestions,
    evidence,
    deadline,
    referral,
    profile,
    letterRoute: draft.letterRoute,
    packetForms: draft.packetForms,
    eligibility: draft.eligibility,
  };
}

/** What the case runs on: the saved pack it pinned, or its accepted draft. */
async function packOf(
  ctx: QueryCtx,
  c: Case,
): Promise<Doc<"processPacks"> | Draft | null> {
  const selection = currentChoice(c);
  const id = definitionOf(selection)?.id;
  return id
    ? await ctx.db.get("processPacks", id)
    : (draftOf(selection) ?? null);
}

// --- 1. Intake --------------------------------------------------------------

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
    facts: v.optional(vFoundFacts),
  },
  returns: v.null(),
  handler: async (ctx, { caseId, promptMessageId, reply, goal, facts }) => {
    const found = await ctx.db.get("cases", caseId);
    if (!found || found.status !== "active") return null;
    for (const entry of facts ?? [])
      await offerFact(ctx, found, entry.fact, entry.text, "Your conversation");
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
    if (goalText) patch.goal = newGoal(found, goalText);
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
    if (!found?.goal || found.run?.state !== "running")
      throw new Error("The case has no goal or running workflow");
    const { text: goal, version: goalVersion } = found.goal;
    return {
      goal,
      goalVersion,
      threadId: found.threadId,
      workflowId: found.run.workflowId,
    };
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
      found.run?.state !== "running" ||
      found.run.workflowId !== origin.workflowId ||
      found.goal?.version !== goalVersion
    )
      return false;
    const stored = packId ? await ctx.db.get("processPacks", packId) : null;
    const definition =
      stored &&
      (stored.ownerId === undefined || stored.ownerId === found.userId)
        ? processPackDefinition(stored)
        : undefined;
    // One kind of thing is proposed: a saved pack, else a draft, else a
    // referral.
    const choice = definition
      ? { kind: "pack" as const, definition }
      : draft
        ? { kind: "draft" as const, draft, research }
        : referral
          ? { kind: "referral" as const, jurisdiction }
          : undefined;
    // Nothing usable (e.g. a pack this person can't see): say nothing, so
    // the thread never announces a proposal the case doesn't have.
    if (!needsClarification && !choice) return false;
    await selectionAgent.saveMessage(ctx, {
      threadId: found.threadId,
      message: { role: "assistant", content: message },
      skipEmbeddings: true,
    });
    // A question for the person sends the case back to intake, like a
    // rejection: the goal as it stands can't be matched.
    await writeCase(ctx, caseId, {
      selection:
        needsClarification || !choice
          ? { status: "rejected", goalVersion, reason: "clarification" }
          : { status: "proposed", goalVersion, ...choice },
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

// --- Suggest ----------------------------------------------------------------

/**
 * What suggesting reads: the accepted pack's unanswered questions, and
 * everything the person has said, in chat and as their goal.
 */
export const suggestInput = internalQuery({
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
    if (!found?.goal) throw new Error("The case has no goal");
    const questions = openQuestions(found);
    const { page } = await listMessages(ctx, components.agent, {
      threadId: found.threadId,
      paginationOpts: { cursor: null, numItems: 50 },
    });
    const said = page
      .reverse()
      .filter((message) => message.message?.role === "user" && message.text)
      .map((message) => message.text!);
    // The goal is the person's too: a proposal only follows a stated one.
    said.push(found.goal.text);
    // So is their paperwork: what each attached file states.
    for (const file of caseEvidence(found)) {
      const line = attachedLine(file);
      // One attached during intake is already in the conversation.
      if (line && !said.includes(line)) said.push(line);
    }
    // So is what they answered on earlier forms: a similar question here
    // may already be answered. Offered back, never filled in.
    for (const { question, answer } of await rememberedElsewhere(ctx, found)) {
      said.push(
        `On an earlier form, asked "${question}", I answered: ${answer}`,
      );
    }
    return {
      goalVersion: found.goal.version,
      threadId: found.threadId,
      questions,
      said,
    };
  },
});

/** The accepted pack's questions the case has no answer to yet. */
export function openQuestions(c: Case) {
  return [
    ...new Set([
      ...(pinnedPack(c)?.inputs ?? []),
      ...(pinnedPack(c)?.letterRoute?.inputs ?? []),
      ...(pinnedPack(c)?.packetForms ?? []).flatMap((form) => form.inputs),
    ]),
  ]
    .filter((key) => c.answers[key] === undefined)
    .map((key) => ({
      key,
      question: questionOf(c, key),
      kind: answerKind(c, key),
    }));
}

/** What a read file states, as a line of what the person has said. */
export function attachedLine(file: Evidence): string | undefined {
  return file.read.status === "read"
    ? `I attached "${file.name}". It says: ${file.read.summary}`
    : undefined;
}

/**
 * Keeps what was found, as suggestions: the person still has to accept
 * them. Recorded even when empty: that's what lets the case ask for answers.
 */
export const recordSuggestions = internalMutation({
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
      found.goal?.version !== goalVersion ||
      !isSuggesting(found)
    ) {
      return null;
    }
    await writeCase(ctx, caseId, { chatSuggestions: { goalVersion, answers } });
    const keys = Object.keys(answers);
    if (keys.length) {
      await logCaseEvent(ctx, caseId, "answers.suggested", keys.join(", "));
    }
    return null;
  },
});

// --- 3. Answers, the document, and review -----------------------------------

/** The answers to the questions the pack's checklist is tailored by. */
function situationOf(c: Case, pack: Awaited<ReturnType<typeof packOf>>) {
  return (pack?.output?.tailorBy ?? [])
    .filter((key) => c.answers[key])
    .map((key) => ({
      question: questionOf(c, key),
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
 * person. It was chosen for the answers as they stood (`fingerprint`), and
 * so was the filled form: if they've changed since, the document is out of
 * date on its own, and the case builds again.
 */
export const packetInput = internalQuery({
  args: { caseId: v.id("cases") },
  returns: v.object({
    forms: v.array(vPacketForm),
    answers: v.record(v.string(), v.string()),
    fingerprint: v.string(),
  }),
  handler: async (ctx, { caseId }) => {
    const c = await ctx.db.get("cases", caseId);
    if (!c) throw new Error("Case not found");
    return {
      forms: activeForms(c),
      answers: c.answers,
      fingerprint: fingerprintOf(c),
    };
  },
});

export const recordArtifact = internalMutation({
  args: {
    caseId: v.id("cases"),
    assessment: v.optional(
      v.object({ fingerprint: v.string(), openItems: v.array(v.string()) }),
    ),
    packet: v.optional(
      v.object({
        fingerprint: v.string(),
        documents: v.array(vPacketPdf),
        openItems: v.array(v.string()),
      }),
    ),
    tailored: v.optional(
      v.object({ fingerprint: v.string(), keep: v.array(v.number()) }),
    ),
    /**
     * The official form, filled in, when the pack fills one, with the
     * fingerprint of the answers it was filled from.
     */
    document: v.optional(
      v.object({ ...vFilledDocument.fields, fingerprint: v.string() }),
    ),
  },
  returns: v.null(),
  handler: async (
    ctx,
    { caseId, tailored, packet, assessment, document: filled },
  ) => {
    const found = await ctx.db.get("cases", caseId);
    if (!found) return null;
    const current = fingerprintOf(found);
    // Each part was made from the answers as they stood then. If any part
    // is behind them now (a profile save reaches a case at any time), so is
    // the artifact: it takes that part's fingerprint, and the case builds
    // again.
    const behind = [
      tailored?.fingerprint,
      filled?.fingerprint,
      packet?.fingerprint,
      assessment?.fingerprint,
    ].find((made) => made !== undefined && made !== current);
    let document: Infer<typeof vFilledDocument> | undefined;
    if (filled) {
      const { fingerprint: _madeFrom, ...rest } = filled;
      document = rest;
    }
    const pack = await packOf(ctx, found);
    const steps = pack?.output?.checklist ?? [];
    // Only the pack's own steps, in its order.
    const checklist = tailored
      ? steps.filter((_, i) => tailored.keep.includes(i + 1))
      : steps.length
        ? steps
        : undefined;
    const summary = JSON.stringify({
      process: pack?.title,
      answers: found.answers,
      output: pack?.output,
      checklist,
    });
    const letter = routeApplies(found, pack?.letterRoute)
      ? pack?.output?.letter
      : undefined;
    const openItems = [
      ...missing(found).map((key) => `Answer: ${questionOf(found, key)}`),
      ...missingEvidence(found).map(
        (key) =>
          `Attach: ${pack?.evidence?.find((file) => file.key === key)?.label ?? key}`,
      ),
      ...(packet?.openItems ?? []),
      ...unbackedForms(found).map(editionCheck),
      // What the pack's last check found changed at the authority.
      ...(await stalenessOf(ctx, pinnedPack(found)?.id)),
      ...(assessment?.openItems ?? []),
    ];
    if (found.artifact)
      await ctx.db.insert("packetRevisions", {
        caseId,
        artifact: found.artifact,
      });
    await writeCase(ctx, caseId, {
      reassess: undefined,
      revised: undefined,
      // Counted on the case, until a document is accepted.
      builds: (found.builds ?? 0) + 1,
      artifact: {
        filingOrder: pack?.output?.filingOrder,
        sources: pack?.output?.sources,
        revision: (found.artifact?.revision ?? 0) + 1,
        documents: packet?.documents,
        openItems: openItems.length ? [...new Set(openItems)] : undefined,
        eligibility: pack?.eligibility?.map((rule) => ({
          condition: rule.condition,
          sourceUrl: rule.sourceUrl,
          outcome:
            !found.answers[rule.key] ||
            found.answers[rule.key].trim().toLowerCase() === "unknown"
              ? "Unknown"
              : found.answers[rule.key].trim().toLowerCase() ===
                  rule.qualifiesWhen.toLowerCase()
                ? "Appears satisfied"
                : "Needs review",
        })),
        summary,
        letter: letter ? renderLetter(letter, found.answers) : undefined,
        checklist,
        document,
        fingerprint: behind ?? current,
      },
    });
    await logCaseEvent(
      ctx,
      caseId,
      "artifact.filled",
      checklist
        ? `${checklist.length} of ${steps.length} steps apply`
        : undefined,
    );
    return null;
  },
});

// --- 4. The end -------------------------------------------------------------

/**
 * Finishes the case: prepares delivery if the pack has a channel, and marks
 * it done. Safe to run twice.
 */
export async function finishCase(ctx: MutationCtx, found: Case): Promise<void> {
  if (found.status !== "active") return;
  const pack = await packOf(ctx, found);
  if (pack?.delivery) {
    await writeCase(ctx, found._id, {
      delivery: { status: "prepared", channel: pack.delivery },
    });
  }
  // What the case changed about the person is offered to their profile,
  // for them to confirm: the new address becomes the home address.
  for (const { input, updates } of pinnedPack(found)?.profile ?? []) {
    const text = updates && found.answers[input];
    if (!text) continue;
    await offerFact(ctx, found, updates!, text);
  }
  await endCase(ctx, found, "done");
}

/** Stops the case with a reason, e.g. when no supported process fits. */
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

export const assessmentInput = internalQuery({
  args: { caseId: v.id("cases") },
  returns: v.union(
    v.null(),
    v.object({
      threadId: v.string(),
      fingerprint: v.string(),
      instructions: v.array(v.string()),
      evidence: v.array(v.string()),
      answers: v.record(v.string(), v.string()),
    }),
  ),
  handler: async (ctx, { caseId }) => {
    const c = await ctx.db.get("cases", caseId);
    if (
      !c ||
      (!c.reassess &&
        !(
          pinnedPack(c)?.packetForms?.length || pinnedPack(c)?.evidence?.length
        ))
    )
      return null;
    const pack = await packOf(ctx, c);
    return {
      threadId: c.threadId,
      fingerprint: fingerprintOf(c),
      answers: c.answers,
      instructions: [
        ...(pack?.output?.checklist ?? []),
        ...(pack?.evidence ?? [])
          .filter((item) => routeApplies(c, item.when))
          .map((item) => item.label),
      ],
      evidence: caseEvidence(c).map(
        (file) =>
          attachedLine(file) ??
          `Attached ${file.name}. Its contents have not been established.`,
      ),
    };
  },
});

export const draftToRevisit = internalQuery({
  args: { caseId: v.id("cases") },
  returns: v.union(
    v.null(),
    v.object({
      caseId: v.id("cases"),
      threadId: v.string(),
      draft: vProcessPackDefinition,
      notes: v.string(),
    }),
  ),
  handler: async (ctx, { caseId }) => {
    const c = await ctx.db.get("cases", caseId);
    const choice = c && currentChoice(c);
    if (!c || !needsRevisit(c) || choice?.kind !== "draft") return null;
    return {
      caseId,
      threadId: c.threadId,
      draft: choice.draft,
      notes: choice.research ?? "",
    };
  },
});

/**
 * Keeps the revisited draft, if revisiting found one, and marks the case
 * revisited either way: it's done once per reassessment.
 */
export const reviseDraft = internalMutation({
  args: {
    caseId: v.id("cases"),
    revision: v.union(
      v.null(),
      v.object({ draft: vProcessPackDefinition, notes: v.string() }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, { caseId, revision }) => {
    const c = await ctx.db.get("cases", caseId);
    if (c?.status !== "active") return null;
    const choice = currentChoice(c);
    if (
      !revision ||
      !c.reassess ||
      choice?.kind !== "draft" ||
      choice.status !== "accepted"
    ) {
      await writeCase(ctx, caseId, { revised: true });
      return null;
    }
    const { draft, notes } = revision;
    await writeCase(ctx, caseId, {
      revised: true,
      selection: {
        ...choice,
        draft,
        research: notes,
        definition: draftDefinition(draft),
      },
    });
    await syncCase(ctx, caseId);
    return null;
  },
});
