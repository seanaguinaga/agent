// What a stage is: a workflow that takes a case and returns a `StageResult`,
// plus the events a person may send it while it's active. Everything a stage
// file needs to be a stage is here.
import {
  defineEvent,
  WorkflowManager,
  type WorkflowArgs,
  type WorkflowCtx,
  type WorkflowMutationResult,
} from "@convex-dev/workflow";
import type { FunctionReference } from "convex/server";
import { v, type ObjectType } from "convex/values";
import { components, internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import {
  vParams,
  vStageResult,
  type CaseEvent,
  type StageResult,
} from "./validators";

export type Case = Doc<"cases">;

export const workflow = new WorkflowManager(components.workflow, {
  workpoolOptions: {
    // Stage actions must be idempotent: they're retried unless they opt out.
    retryActionsByDefault: true,
    defaultRetryBehavior: { maxAttempts: 3, initialBackoffMs: 500, base: 2 },
  },
});

// --- The workflow -----------------------------------------------------------

const stageArgs = {
  caseId: v.id("cases"),
  stepId: v.string(),
  params: v.optional(vParams),
};
export type StageArgs = ObjectType<typeof stageArgs>;

/** A reference to a stage workflow, as `step.runWorkflow` takes it. */
export type StageWorkflow = FunctionReference<
  "mutation",
  "internal",
  WorkflowArgs<typeof stageArgs>,
  WorkflowMutationResult<StageResult>
>;

/**
 * Defines a stage workflow. Every stage first records its workflow id on the
 * case, so `send` knows which workflow to nudge.
 */
export function defineStage(
  run: (step: WorkflowCtx, args: StageArgs) => Promise<StageResult>,
) {
  return workflow.define({
    args: stageArgs,
    returns: vStageResult,
    handler: async (step, args): Promise<StageResult> => {
      await step.runMutation(internal.easygov.pipeline.setActive, {
        caseId: args.caseId,
        stepId: args.stepId,
        workflowId: step.workflowId,
      });
      return await run(step, args);
    },
  });
}

// --- Waiting for a person ---------------------------------------------------

/**
 * Sent to the active stage workflow. It only means "look again": it carries
 * nothing, because the truth is in the tables.
 */
export const stageEvent = defineEvent({ name: "stage", validator: v.null() });

const MAX_WAKES = 100;

/**
 * Waits until `check` (a `step.runQuery` that reads the tables) returns
 * something. Each "stage" event is a nudge to check again. Events sent before
 * the stage started waiting are buffered, so none are missed.
 */
export async function waitFor<T>(
  step: WorkflowCtx,
  check: () => Promise<T | null>,
): Promise<T> {
  for (let wakes = 0; wakes <= MAX_WAKES; wakes++) {
    const found = await check();
    if (found !== null) return found;
    await step.awaitEvent(stageEvent);
  }
  throw new Error(`Still waiting after ${MAX_WAKES} nudges`);
}

// --- The events a person can send it ----------------------------------------

/** Events that belong to the case or the parent, not to any one stage. */
type ControlEvent = "case.cancel" | "step.retry" | "step.cancel";

export type StageEventType = Exclude<CaseEvent["type"], ControlEvent>;

/**
 * The events a stage accepts while it's active. A handler turns an event into
 * the fields it writes on the case; the stage's workflow then notices the
 * change.
 */
export type StageEvents = {
  [K in StageEventType]?: (
    found: Case,
    event: Extract<CaseEvent, { type: K }>,
  ) => Partial<Case>;
};
