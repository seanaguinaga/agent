// How a decision is carried out. There is no parent workflow: a case moves
// only through `handle(input)`, which asks `decide` (`decide.ts`, pure) what
// to do and then applies it here: start the next stage's workflow, or park or
// end the case. A stage workflow reports back through `stageDone`, its
// `onComplete`. A callback for a step or visit the case has moved on from is
// stale, and ignored.
import { vResultValidator, vWorkflowId } from "@convex-dev/workflow";
import { v } from "convex/values";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../../_generated/server";
import type { StageResult } from "../case/schema";
import { writeCase, type Case } from "../case/data";
import { workflow } from "../stages/shared";
import { stageTypeOf, STAGES } from "../stages/registry";
import { decide, type Decision, type Input } from "./decide";

// --- apply: I/O -------------------------------------------------------------

/** Carries out a decision: starts a workflow, patches the case, logs. */
async function apply(
  ctx: MutationCtx,
  c: Case,
  decision: Decision,
): Promise<void> {
  switch (decision.type) {
    case "run": {
      const { step, plan, notes } = decision;
      const type = stageTypeOf(step.type);
      if (!type) {
        throw new Error(`Unknown stage type "${step.type}"`);
      }
      const visit = (c.visits[step.id] ?? 0) + 1;
      const workflowId = await workflow.start(
        ctx,
        STAGES[type].workflow,
        { caseId: c._id, stepId: step.id, params: step.params },
        {
          onComplete: internal.easygov.plans.data.stageDone,
          context: { caseId: c._id, stepId: step.id, visit },
          // Not inline: a stage that fails at once would call `stageDone`
          // before the patch below, and look stale.
          startAsync: true,
        },
      );
      await writeCase(ctx, "core", c._id, {
        plan,
        currentStep: step.id,
        visits: { ...c.visits, [step.id]: visit },
        workflowId,
        failure: undefined,
      });
      await logNotes(ctx, c._id, notes);
      await logEvent(ctx, c._id, "step.started", `${step.id} #${visit}`);
      return;
    }
    case "park": {
      const { stepId, error } = decision;
      await writeCase(ctx, "core", c._id, {
        failure: { stepId, error },
        workflowId: undefined,
      });
      await logEvent(ctx, c._id, "step.failed", `${stepId}: ${error}`);
      return;
    }
    case "end": {
      const { status, reason, notes } = decision;
      // Only a cancel ends a case while its stage is still running.
      if (status === "canceled" && c.workflowId) {
        await workflow.cancel(ctx, c.workflowId);
      }
      await logNotes(ctx, c._id, notes);
      await endCase(ctx, c, status, reason);
      return;
    }
    case "ignore":
      console.log(`Case ${c._id}: ignored. ${decision.why}`);
      return;
  }
}

/** The one way a case moves: read it, decide, apply. Returns the decision. */
export async function handle(
  ctx: MutationCtx,
  caseId: Id<"cases">,
  input: Input,
): Promise<Decision> {
  const c = await ctx.db.get("cases", caseId);
  if (!c) throw new Error(`No case ${caseId}`);
  const decision = decide(c, input);
  await apply(ctx, c, decision);
  return decision;
}

// --- How a stage workflow reports back --------------------------------------

/** The `onComplete` of every stage workflow: turns its result into an input. */
export const stageDone = internalMutation({
  args: {
    workflowId: vWorkflowId,
    result: vResultValidator,
    context: v.object({
      caseId: v.id("cases"),
      stepId: v.string(),
      visit: v.number(),
    }),
  },
  returns: v.null(),
  handler: async (ctx, { result, context }): Promise<null> => {
    const { caseId, stepId, visit } = context;
    // We cancel a stage only when ending its case: nothing more to do.
    if (result.kind === "canceled") return null;
    if (result.kind === "failed") {
      const { error } = result;
      await handle(ctx, caseId, { type: "stageFailed", stepId, visit, error });
      return null;
    }
    const stageResult: StageResult = result.returnValue;
    try {
      await handle(ctx, caseId, {
        type: "stageDone",
        stepId,
        visit,
        result: stageResult,
      });
    } catch (thrown) {
      // A result we can't route (e.g. `back` to a missing step) is a bug in
      // the stage. Park the case, so it shows the error and isn't stuck.
      const error = thrown instanceof Error ? thrown.message : String(thrown);
      await handle(ctx, caseId, { type: "stageFailed", stepId, visit, error });
    }
    return null;
  },
});

// --- Ending and logging -----------------------------------------------------

/** Ends a case. Only "done" is success; every other status has a reason. */
async function endCase(
  ctx: MutationCtx,
  c: Case,
  status: Exclude<Case["status"], "active">,
  endReason?: string,
): Promise<void> {
  const notRunning = {
    currentStep: undefined,
    workflowId: undefined,
    failure: undefined,
  };
  await writeCase(ctx, "core", c._id, { ...notRunning, status, endReason });
  await logEvent(ctx, c._id, `case.${status}`, endReason);
}

/** Appends to `caseEvents`, the history of a case. */
async function logEvent(
  ctx: MutationCtx,
  caseId: Id<"cases">,
  kind: string,
  detail?: string,
): Promise<void> {
  await ctx.db.insert("caseEvents", { caseId, kind, detail });
}

async function logNotes(
  ctx: MutationCtx,
  caseId: Id<"cases">,
  notes: string[],
): Promise<void> {
  for (const note of notes) await logEvent(ctx, caseId, "note", note);
}
