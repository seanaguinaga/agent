// A case's work, as short durable workflows. See
// https://docs.convex.dev/agents/workflows
//
// Nothing here loops or waits for a person. Each workflow is one piece of
// work, top to bottom, and then it ends:
//
// - `intake` answers one chat message.
// - `propose` proposes a process for the goal.
// - `suggest` reads what the person already said for answers.
// - `revise` revisits a drafted process the person asked to reassess.
// - `build` builds the document from the answers.
//
// The case in the table is the truth. After every write, and whenever a
// workflow ends, `advance` asks `nextWork` (in `state.ts`) what the case
// needs now and starts it. If that's nothing, the case waits for the
// person and nothing runs. So a retry starts whatever the case needs now,
// and that picks up wherever the case is.
import {
  vResultValidator,
  vWorkflowId,
  WorkflowManager,
} from "@convex-dev/workflow";
import { v } from "convex/values";
import { components, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../../_generated/server";
import { admitWork } from "../limits";
import { endCase, finishCase, logCaseEvent, writeCase } from "./data";
import { nextWork } from "./state";

export const workflow = new WorkflowManager(components.workflow, {
  workpoolOptions: {
    // Actions must be safe to repeat: they're retried unless they opt out.
    retryActionsByDefault: true,
    defaultRetryBehavior: { maxAttempts: 3, initialBackoffMs: 500, base: 2 },
  },
});

/** Answers one chat message. `recordTurn` keeps the goal, if it found one. */
export const intake = workflow.define({
  args: { caseId: v.id("cases"), promptMessageId: v.string() },
  returns: v.null(),
  handler: async (step, { caseId, promptMessageId }): Promise<null> => {
    const turn = await step.runAction(
      internal.easygov.case.agents.intakeTurn,
      { caseId, promptMessageId },
      { retry: true },
    );
    await step.runMutation(internal.easygov.case.data.recordTurn, {
      caseId,
      promptMessageId,
      ...turn,
    });
    return null;
  },
});

/** Proposes a process for the case's goal, or asks a clarifying question. */
export const propose = workflow.define({
  args: { caseId: v.id("cases") },
  returns: v.null(),
  handler: async (step, { caseId }): Promise<null> => {
    const data = internal.easygov.case.data;
    const proposal = await step.runAction(
      internal.easygov.case.agents.propose,
      { caseId },
      { retry: true },
    );
    if (!(await step.runMutation(data.recordProposal, { caseId, ...proposal })))
      await step.runMutation(data.stop, {
        caseId,
        reason: "No supported process fits yet",
      });
    return null;
  },
});

/**
 * Reads what the person already said for answers to the pack's questions:
 * those are offered back for them to accept, so they aren't asked twice.
 */
export const suggest = workflow.define({
  args: { caseId: v.id("cases") },
  returns: v.null(),
  handler: async (step, { caseId }): Promise<null> => {
    const found = await step.runAction(
      internal.easygov.case.agents.suggest,
      { caseId },
      { retry: true },
    );
    await step.runMutation(internal.easygov.case.data.recordSuggestions, {
      caseId,
      ...found,
    });
    return null;
  },
});

/**
 * Revisits a drafted process once, after the person asked to reassess. It
 * may ask for more answers; the document is built when they're in.
 */
export const revise = workflow.define({
  args: { caseId: v.id("cases") },
  returns: v.null(),
  handler: async (step, { caseId }): Promise<null> => {
    const data = internal.easygov.case.data;
    const revisit = await step.runQuery(data.draftToRevisit, { caseId });
    const revision = revisit
      ? await step.runAction(internal.easygov.case.agents.revisitDraft, revisit)
      : null;
    await step.runMutation(data.reviseDraft, { caseId, revision });
    return null;
  },
});

/** Builds the document from the answers as they stand, for review. */
export const build = workflow.define({
  args: { caseId: v.id("cases") },
  returns: v.null(),
  handler: async (step, { caseId }): Promise<null> => {
    const data = internal.easygov.case.data;
    // A checklist that covers every route is cut to the person's own.
    const tailored = (await step.runQuery(data.needsTailoring, { caseId }))
      ? await step.runAction(
          internal.easygov.case.agents.tailor,
          { caseId },
          { retry: true },
        )
      : undefined;
    // A pack for an official form gets that form, filled in and checked.
    const form = await step.runQuery(
      internal.easygov.forms.data.editionOfCase,
      { caseId },
    );
    const document = form
      ? await step.runAction(
          internal.easygov.forms.actions.fillForCase,
          { caseId },
          { retry: true },
        )
      : null;
    const assessmentInput = await step.runQuery(data.assessmentInput, {
      caseId,
    });
    const { forms } = await step.runQuery(data.packetInput, { caseId });
    const packet = forms.length
      ? await step.runAction(internal.easygov.forms.actions.fillPacket, {
          caseId,
        })
      : undefined;
    const assessment = assessmentInput
      ? await step.runAction(internal.easygov.case.agents.assessPacket, {
          ...assessmentInput,
          preparedForms: [
            ...(packet?.documents ?? []).map((doc) => ({
              code: doc.code,
              omissions: doc.omissions.map((item) => item.reason),
              manual: doc.toComplete.map((item) => item.note),
            })),
            ...(document
              ? [
                  {
                    code: "Official form",
                    omissions: document.omissions.map((item) => item.reason),
                    manual: document.toComplete.map((item) => item.note),
                  },
                ]
              : []),
          ],
        })
      : undefined;
    await step.runMutation(data.recordArtifact, {
      ...(packet && { packet }),
      ...(assessment && { assessment }),
      caseId,
      ...(tailored && { tailored }),
      ...(document && { document }),
    });
    return null;
  },
});

// --- What starts them -------------------------------------------------------

/**
 * Call after a write to a case. With no work in hand, it starts what the
 * case needs now: a workflow, the end of the case, or (most often) nothing.
 * At most one piece of work runs per case, recorded as its `run`. Model work
 * that doesn't fit the budgets in `limits.ts` is delayed, and a case that
 * starts too much on its own is parked as failed.
 */
export async function advance(
  ctx: MutationCtx,
  caseId: Id<"cases">,
): Promise<void> {
  const c = await ctx.db.get("cases", caseId);
  const work = c && nextWork(c);
  if (!work) return;
  const flows = internal.easygov.case.workflow;
  if (work.kind === "stop")
    return await endCase(ctx, c, "stopped", work.reason);
  if (work.kind === "finish") return await finishCase(ctx, c);
  // Everything else calls a model, so it has to fit the budgets.
  const admitted = await admitWork(ctx, c);
  if (!admitted.ok) {
    if ("runaway" in admitted) {
      const error = "This case started too much work in a short time";
      // Something is looping: say so where an operator's log alerts look.
      console.error(
        `easygov runaway: case ${caseId} parked before ${work.kind}`,
      );
      await writeCase(ctx, caseId, { run: { state: "failed", error } });
      return await logCaseEvent(ctx, caseId, "case.failed", error);
    }
    // Its turn will come: look again then. Meanwhile the case has work in
    // hand, so nothing else starts or piles up behind it.
    const until = Date.now() + admitted.wait;
    await writeCase(ctx, caseId, { run: { state: "delayed", until } });
    await ctx.scheduler.runAt(until, flows.resume, { caseId, until });
    return;
  }
  const started = {
    onComplete: internal.easygov.case.workflow.workflowDone,
    context: { caseId },
    // Not inline: a run that fails at once would report back before the
    // case knows its workflow id, and be ignored.
    startAsync: true,
  };
  const workflowId =
    work.kind === "intake"
      ? await workflow.start(
          ctx,
          flows.intake,
          { caseId, promptMessageId: work.promptMessageId },
          started,
        )
      : await workflow.start(ctx, flows[work.kind], { caseId }, started);
  await writeCase(ctx, caseId, { run: { state: "running", workflowId } });
}

/** Starts the work a rate limit delayed, now that its turn has come. */
export const resume = internalMutation({
  args: { caseId: v.id("cases"), until: v.number() },
  returns: v.null(),
  handler: async (ctx, { caseId, until }) => {
    const found = await ctx.db.get("cases", caseId);
    // Canceled, retried or ended meanwhile: this wake-up is nobody's.
    if (found?.run?.state !== "delayed" || found.run.until !== until)
      return null;
    await writeCase(ctx, caseId, { run: undefined });
    await advance(ctx, caseId);
    return null;
  },
});

/**
 * Every workflow's `onComplete`. A failure parks the case: it keeps the
 * error until the person retries or gives up. Otherwise the work is done,
 * and the case starts what it needs next, or waits for the person.
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
    // A case that ended, or moved on to other work, has nothing to hear.
    if (found?.run?.state !== "running" || found.run.workflowId !== workflowId)
      return null;
    if (result.kind === "failed") {
      await writeCase(ctx, found._id, {
        run: { state: "failed", workflowId, error: result.error },
      });
      await logCaseEvent(ctx, found._id, "case.failed", result.error);
    } else {
      await writeCase(ctx, found._id, { run: undefined });
      await advance(ctx, found._id);
    }
    return null;
  },
});
