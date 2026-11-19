// How a case runs. One parent workflow per case (`govCase`) loops: run the
// step's stage, then ask `advance` what's next. Every routing decision is a
// mutation in this file, journaled by the parent workflow.
import {
  defineEvent,
  vResultValidator,
  vWorkflowId,
  type WorkflowCtx,
} from "@convex-dev/workflow";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import { getPack } from "./packs";
import {
  bootstrapPlan,
  insertAfter,
  MAX_VISITS,
  nextRunnableStep,
  validateAppend,
} from "./plan";
import { workflow } from "./stage";
import { isStageType, STAGES } from "./stages/stages.registry";
import {
  vNextStep,
  vStageResult,
  type NextStep,
  type PlanStep,
  type StageResult,
} from "./validators";

type Case = Doc<"cases">;

// --- The parent workflow ----------------------------------------------------

export const govCase = workflow.define({
  args: { caseId: v.id("cases") },
  returns: v.null(),
  handler: async (step, { caseId }): Promise<null> => {
    let next: NextStep | null = await step.runMutation(
      internal.easygov.pipeline.pin,
      { caseId },
    );
    while (next) {
      const result = await runStage(step, caseId, next);
      next = await step.runMutation(internal.easygov.pipeline.advance, {
        caseId,
        stepId: next.id,
        result,
      });
    }
    return null;
  },
});

/** Sent to the parent workflow after a stage fails: try again, or give up. */
export const recoveryEvent = defineEvent({
  name: "recovery",
  validator: v.object({
    kind: v.union(v.literal("retry"), v.literal("cancel")),
  }),
});

/** Runs one stage. A failure waits for a person to retry or cancel. */
async function runStage(
  step: WorkflowCtx,
  caseId: Id<"cases">,
  { id, type, params, visits }: NextStep,
): Promise<StageResult> {
  try {
    if (!isStageType(type)) throw new Error(`Unknown stage type "${type}"`);
    return await step.runWorkflow(
      STAGES[type].workflow,
      { caseId, stepId: id, params },
      // A step can run more than once, so its visit count is in the name.
      { name: `stage:${id}:${visits}` },
    );
  } catch (error) {
    await step.runMutation(
      internal.easygov.pipeline.markFailed,
      {
        caseId,
        stepId: id,
        error: error instanceof Error ? error.message : String(error),
      },
      // The error text can differ when the workflow replays.
      { unstableArgs: true },
    );
    const { kind } = await step.awaitEvent(recoveryEvent);
    return kind === "retry"
      ? { outcome: "back", backTo: id }
      : { outcome: "stop", reason: `Canceled after "${id}" failed` };
  }
}

/** Records a parent workflow that crashed or was canceled from outside. */
export const caseDone = internalMutation({
  args: {
    workflowId: vWorkflowId,
    result: vResultValidator,
    context: v.object({ caseId: v.id("cases") }),
  },
  returns: v.null(),
  handler: async (ctx, { result, context }) => {
    const found = await ctx.db.get("cases", context.caseId);
    if (!found || found.status !== "active") return null;
    if (result.kind === "failed") {
      await endCase(ctx, found, "failed", result.error);
    } else if (result.kind === "canceled") {
      await endCase(ctx, found, "canceled", "Workflow canceled");
    }
    return null;
  },
});

// --- Routing decisions ------------------------------------------------------

/** Writes the bootstrap plan and returns its first step. */
export const pin = internalMutation({
  args: { caseId: v.id("cases") },
  returns: v.union(vNextStep, v.null()),
  handler: async (ctx, { caseId }): Promise<NextStep | null> => {
    const found = await ctx.db.get("cases", caseId);
    if (!found || found.status !== "active") return null;
    const first = bootstrapPlan[0];
    await ctx.db.patch("cases", caseId, {
      plan: bootstrapPlan,
      stepStatus: { [first.id]: { status: "active", visits: 1 } },
      stage: first.type,
      activeStepId: first.id,
      activeWorkflowId: undefined,
      seq: found.seq + 1,
    });
    await logEvent(ctx, caseId, "planPinned");
    return { ...first, visits: 1 };
  },
});

/**
 * Called by the parent workflow after every stage. Given how the step ended,
 * it returns the step to run next, or null when the case is over. It runs as
 * one transaction, so the case is never half-updated.
 */
export const advance = internalMutation({
  args: { caseId: v.id("cases"), stepId: v.string(), result: vStageResult },
  returns: v.union(vNextStep, v.null()),
  handler: async (
    ctx,
    { caseId, stepId, result },
  ): Promise<NextStep | null> => {
    const found = await ctx.db.get("cases", caseId);
    if (!found || found.status !== "active") return null;
    if (!found.plan.some((step) => step.id === stepId)) {
      throw new Error(`No step "${stepId}" in the plan`);
    }

    const amended = await amendPlan(ctx, found, stepId, result);
    const stepStatus = await recordStep(ctx, found, amended, stepId, result);
    const choice = chooseNext(found, amended, stepStatus, stepId, result);
    if ("end" in choice) {
      await endCase(ctx, found, choice.end, choice.reason);
      return null;
    }
    return await enterStep(ctx, found, stepStatus, choice.next);
  },
});

type Amended = Pick<Case, "plan" | "appended" | "processKey"> & {
  /** Set when amending found a reason to stop the case. */
  stopReason?: string;
};

/**
 * 1. Changes the plan if needed: steps the stage proposed, and after a
 * confirmed route, the chosen pack's steps.
 */
async function amendPlan(
  ctx: MutationCtx,
  found: Case,
  stepId: string,
  result: StageResult,
): Promise<Amended> {
  let { plan, appended, processKey } = found;
  let stopReason: string | undefined;

  if (result.append?.length) {
    const problem = validateAppend(plan, result.append, appended);
    if (problem) {
      await logEvent(ctx, found._id, "appendRefused", problem);
    } else {
      plan = insertAfter(plan, stepId, result.append);
      appended += result.append.length;
      const ids = result.append.map((step) => step.id).join(", ");
      await logEvent(ctx, found._id, "planAmended", `${stepId} added ${ids}`);
    }
  }

  const isRoute = plan.find((step) => step.id === stepId)?.type === "route";
  if (isRoute && result.outcome === "done" && !processKey) {
    const pack = getPack(found.route?.processKey);
    if (pack) {
      plan = insertAfter(plan, stepId, pack.plan);
      processKey = pack.key;
      await logEvent(ctx, found._id, "planAmended", `routed to ${pack.key}`);
    } else {
      stopReason = "No known process was confirmed";
    }
  }
  return { plan, appended, processKey, stopReason };
}

/** How a stage's outcome shows in the step's status. */
const STATUS_FOR_OUTCOME = {
  done: "done",
  back: "sentBack",
  stop: "stopped",
} as const;

/** 2. Saves the amended plan and how the step ended. */
async function recordStep(
  ctx: MutationCtx,
  found: Case,
  { plan, appended, processKey }: Amended,
  stepId: string,
  result: StageResult,
): Promise<Case["stepStatus"]> {
  // `patch` replaces whole fields, so write the whole status record.
  const stepStatus: Case["stepStatus"] = {
    ...found.stepStatus,
    [stepId]: {
      visits: found.stepStatus[stepId]?.visits ?? 1,
      status: STATUS_FOR_OUTCOME[result.outcome],
    },
  };
  await ctx.db.patch("cases", found._id, {
    plan,
    appended,
    processKey,
    stepStatus,
  });
  await logEvent(ctx, found._id, `step.${result.outcome}`, stepId);
  return stepStatus;
}

type Choice = { next: PlanStep } | { end: "done" | "stopped"; reason?: string };

/** 3. Picks the next step, or says how the case ends. No writes. */
function chooseNext(
  found: Case,
  { plan, stopReason }: Amended,
  stepStatus: Case["stepStatus"],
  stepId: string,
  result: StageResult,
): Choice {
  if (stopReason) return { end: "stopped", reason: stopReason };
  if (result.outcome === "stop") {
    return {
      end: "stopped",
      reason: result.reason ?? `Stopped at "${stepId}"`,
    };
  }
  const next =
    result.outcome === "back"
      ? plan.find((step) => step.id === result.backTo)
      : nextRunnableStep(plan, stepId, found.answers, found.flags);
  if (!next) {
    return result.outcome === "done"
      ? { end: "done" }
      : { end: "stopped", reason: `Can't go back to "${result.backTo}"` };
  }
  if ((stepStatus[next.id]?.visits ?? 0) >= MAX_VISITS) {
    return { end: "stopped", reason: `"${next.id}" ran ${MAX_VISITS} times` };
  }
  return { next };
}

/** 4. Points the case at the next step, before its workflow starts. */
async function enterStep(
  ctx: MutationCtx,
  found: Case,
  stepStatus: Case["stepStatus"],
  next: PlanStep,
): Promise<NextStep> {
  const visits = (stepStatus[next.id]?.visits ?? 0) + 1;
  await ctx.db.patch("cases", found._id, {
    stepStatus: { ...stepStatus, [next.id]: { status: "active", visits } },
    stage: next.type,
    activeStepId: next.id,
    activeWorkflowId: undefined,
    seq: found.seq + 1,
  });
  return { id: next.id, type: next.type, params: next.params, visits };
}

/** A stage workflow threw. The parent then waits for a recovery event. */
export const markFailed = internalMutation({
  args: { caseId: v.id("cases"), stepId: v.string(), error: v.string() },
  returns: v.null(),
  handler: async (ctx, { caseId, stepId, error }) => {
    const found = await ctx.db.get("cases", caseId);
    if (!found || found.status !== "active") return null;
    await ctx.db.patch("cases", caseId, {
      stepStatus: {
        ...found.stepStatus,
        [stepId]: {
          visits: found.stepStatus[stepId]?.visits ?? 1,
          status: "failed",
          error,
        },
      },
      activeWorkflowId: undefined,
      seq: found.seq + 1,
    });
    await logEvent(ctx, caseId, "step.failed", `${stepId}: ${error}`);
    return null;
  },
});

/** The first step of every stage workflow: tells `send` where to nudge. */
export const setActive = internalMutation({
  args: {
    caseId: v.id("cases"),
    stepId: v.string(),
    workflowId: vWorkflowId,
  },
  returns: v.null(),
  handler: async (ctx, { caseId, stepId, workflowId }) => {
    const found = await ctx.db.get("cases", caseId);
    if (found?.status === "active" && found.activeStepId === stepId) {
      await ctx.db.patch("cases", caseId, { activeWorkflowId: workflowId });
    }
    return null;
  },
});

// --- Ending and logging -----------------------------------------------------

/** Clears "where the case is now" when it ends. */
const NOT_RUNNING = {
  stage: undefined,
  activeStepId: undefined,
  activeWorkflowId: undefined,
};

export async function logEvent(
  ctx: MutationCtx,
  caseId: Id<"cases">,
  kind: string,
  detail?: string,
) {
  await ctx.db.insert("caseEvents", { caseId, kind, detail });
}

/** Ends a case. Only "done" is success; every other status has a reason. */
export async function endCase(
  ctx: MutationCtx,
  found: Case,
  status: Exclude<Case["status"], "active">,
  endReason?: string,
) {
  await ctx.db.patch("cases", found._id, {
    ...NOT_RUNNING,
    status,
    endReason,
    seq: found.seq + 1,
  });
  await logEvent(ctx, found._id, `case.${status}`, endReason);
}
