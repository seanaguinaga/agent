// Every routing rule, as one pure function: given the case and what happened,
// `decide` says what to do. No ctx and no I/O here, so it's tested with plain
// values. `data.ts` carries the decision out.
import type { StageResult } from "../case/schema";
import type { Case } from "../case/data";
import {
  bootstrapPlan,
  insertAfter,
  MAX_VISITS,
  nextRunnableStep,
  validateAppend,
} from "./steps";
import type { PlanStep } from "./schema";

/** Something that happened to a case. */
export type Input =
  | { type: "start" }
  | { type: "stageDone"; stepId: string; visit: number; result: StageResult }
  | { type: "stageFailed"; stepId: string; visit: number; error: string }
  /** A person, after a failure: run the step again. */
  | { type: "retry" }
  /** A person, after a failure: stop the case. */
  | { type: "giveUp" }
  /** A person, at any time. */
  | { type: "cancel" };

/** What to do about it. `notes` go to `caseEvents`, the case's history. */
export type Decision =
  /** Start this step's stage workflow, with this plan on the case. */
  | { type: "run"; step: PlanStep; plan: PlanStep[]; notes: string[] }
  /** The step failed: wait for a retry or a giveUp. */
  | { type: "park"; stepId: string; error: string }
  | {
      type: "end";
      status: "done" | "stopped" | "canceled";
      reason?: string;
      notes: string[];
    }
  /** A stale callback, or something that isn't allowed now. */
  | { type: "ignore"; why: string };

/** Pure: no ctx, no I/O. Every routing rule is here, in one switch. */
export function decide(c: Case, input: Input): Decision {
  if (c.status !== "active") return ignore(`The case is ${c.status}.`);
  switch (input.type) {
    case "start":
      return run(c, bootstrapPlan[0], bootstrapPlan, []);
    case "stageDone":
      if (!isCurrent(c, input)) return ignore("Stale callback.");
      return nextAfter(c, input.stepId, input.result);
    case "stageFailed":
      if (!isCurrent(c, input)) return ignore("Stale callback.");
      return { type: "park", stepId: input.stepId, error: input.error };
    case "retry": {
      const failed = c.plan.find((step) => step.id === c.failure?.stepId);
      if (!failed) return ignore("No failed step to recover.");
      return run(c, failed, c.plan, [`Retrying "${failed.id}"`]);
    }
    case "giveUp":
      if (!c.failure) return ignore("No failed step to recover.");
      return end("stopped", `Canceled after "${c.failure.stepId}" failed`);
    case "cancel":
      return end("canceled", "Canceled by the user");
  }
}

/** Whether a callback is from the run of the step the case is waiting on. */
function isCurrent(c: Case, from: { stepId: string; visit: number }): boolean {
  return c.currentStep === from.stepId && c.visits[from.stepId] === from.visit;
}

/** A stage returned: stop, go back, or find the step to run next. */
function nextAfter(c: Case, stepId: string, result: StageResult): Decision {
  const notes = [`"${stepId}" returned ${result.outcome}`];
  if (result.outcome === "stop") return end("stopped", result.reason, notes);
  if (result.outcome === "back") {
    const target = c.plan.find((step) => step.id === result.backTo);
    if (!target) {
      throw new Error(`"${stepId}" went back to a missing "${result.backTo}"`);
    }
    return run(c, target, c.plan, notes);
  }

  // Done. Steps the stage proposed join the plan after it, if they're valid.
  // A refused batch is noted, and the case carries on without it.
  let plan = c.plan;
  const append = result.append ?? [];
  const refused = validateAppend(plan, append);
  if (refused) {
    notes.push(`"${stepId}" append refused: ${refused}`);
  } else if (append.length) {
    plan = insertAfter(plan, stepId, append);
    const ids = append.map((step) => step.id).join(", ");
    notes.push(`"${stepId}" appended ${ids}`);
  }
  const next = nextRunnableStep(plan, stepId, c.answers, c.flags);
  if (next) return run(c, next, plan, notes);
  // Running out of steps is success, unless steps meant to follow were
  // refused (e.g. a plan after process pack selection): then nothing was done.
  return refused
    ? end("stopped", `Steps refused: ${refused}`, notes)
    : end("done", undefined, notes);
}

/** Run `step`, unless it has already run too many times. */
function run(
  c: Case,
  step: PlanStep,
  plan: PlanStep[],
  notes: string[],
): Decision {
  if ((c.visits[step.id] ?? 0) >= MAX_VISITS) {
    return end("stopped", `"${step.id}" ran ${MAX_VISITS} times`, notes);
  }
  return { type: "run", step, plan, notes };
}

function end(
  status: "done" | "stopped" | "canceled",
  reason?: string,
  notes: string[] = [],
): Decision {
  return { type: "end", status, reason, notes };
}

function ignore(why: string): Decision {
  return { type: "ignore", why };
}
