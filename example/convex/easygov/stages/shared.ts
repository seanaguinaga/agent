// What every stage shares. A stage is a folder, `stages/<name>/`, whose files
// are named for their job: `workflow.ts`, `events.ts`, `data.ts`, `agent.ts`.
// This file has what they're made of: the workflow manager, a stage
// workflow's args, the shape of `events`, and how a stage waits for a person.
import {
  defineEvent,
  WorkflowManager,
  type WorkflowArgs,
  type WorkflowCtx,
  type WorkflowMutationResult,
} from "@convex-dev/workflow";
import type { FunctionReference } from "convex/server";
import { v, type ObjectType } from "convex/values";
import { components } from "../../_generated/api";
import type { MutationCtx } from "../../_generated/server";
import type { Case, Owned } from "../case/data";
import type {
  CaseEvent,
  EventsOf,
  StageName,
  StageResult,
} from "../case/schema";
import { vParams } from "../plans/schema";

export const workflow = new WorkflowManager(components.workflow, {
  workpoolOptions: {
    // Stage actions must be idempotent: they're retried unless they opt out.
    retryActionsByDefault: true,
    defaultRetryBehavior: { maxAttempts: 3, initialBackoffMs: 500, base: 2 },
  },
});

// --- A stage's workflow: `run` ----------------------------------------------

/** The args of every stage workflow. `params` are still flat strings here. */
export const stageArgs = {
  caseId: v.id("cases"),
  stepId: v.string(),
  params: v.optional(vParams),
};
export type StageArgs = ObjectType<typeof stageArgs>;

/** A reference to a stage's `run`, as `workflow.start` takes it. */
export type StageWorkflow = FunctionReference<
  "mutation",
  "internal",
  WorkflowArgs<typeof stageArgs>,
  WorkflowMutationResult<StageResult>
>;

// --- A stage's `events` -----------------------------------------------------

/**
 * One handler per row of `EVENTS` (`case/schema.ts`) the stage owns. A
 * handler returns what to write, and may only return the stage's own fields.
 * Any other writes it makes share the case mutation's transaction.
 */
export type StageEvents<N extends StageName> = {
  [Type in EventsOf<N>]: (
    found: Case,
    event: Extract<CaseEvent, { type: Type }>,
    ctx: MutationCtx,
  ) => Partial<Owned<N>> | Promise<Partial<Owned<N>>>;
};

// --- Waiting for a person ---------------------------------------------------

/**
 * Sent to the running stage workflow. It only means "look again": it carries
 * nothing, because the truth is in the tables.
 */
export const stageEvent = defineEvent({ name: "stage", validator: v.null() });

/**
 * Nudges the stage workflow the case is running, if one is. With none (the
 * step has failed, or the case has ended) there's nothing to do. A stage that
 * hasn't begun waiting yet misses nothing: the event is buffered, and a stage
 * reads the tables when it starts.
 */
export async function nudgeStage(ctx: MutationCtx, found: Case): Promise<void> {
  const { workflowId } = found;
  if (!workflowId) return;
  await workflow.sendEvent(ctx, { ...stageEvent, workflowId, value: null });
}

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
