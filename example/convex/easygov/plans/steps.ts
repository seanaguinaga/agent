// Operations on a plan, which is an ordered list of steps. No database here,
// so these are tested with plain values.
import type { Answers } from "../case/answers";
import { stageTypeOf, STAGES } from "../stages/registry";
import type { Condition, PlanStep } from "./schema";

/** A plan never grows past this, whoever adds the steps. */
export const MAX_PLAN_STEPS = 30;
export const MAX_VISITS = 50;

/** Every case starts here. Process pack selection supplies the rest. */
export const bootstrapPlan: PlanStep[] = [
  { id: "intake", type: "intake" },
  {
    id: "selectProcessPack",
    type: "selectProcessPack",
    params: { backTo: "intake" },
  },
];

/** Decides whether a plan step's `when` passes. */
export function evaluate(
  condition: Condition,
  answers: Answers,
  flags: string[],
): boolean {
  if ("input" in condition)
    return answers[condition.input] === condition.equals;
  if ("flag" in condition) return flags.includes(condition.flag);
  if ("all" in condition) {
    return condition.all.every((c) => evaluate(c, answers, flags));
  }
  return condition.any.some((c) => evaluate(c, answers, flags));
}
export function insertAfter(
  plan: PlanStep[],
  afterId: string,
  steps: PlanStep[],
): PlanStep[] {
  const index = plan.findIndex((step) => step.id === afterId);
  if (index === -1) throw new Error(`No step "${afterId}" in the plan`);
  return [...plan.slice(0, index + 1), ...steps, ...plan.slice(index + 1)];
}

/** The first step after `afterId` whose `when` passes, if any. */
export function nextRunnableStep(
  plan: PlanStep[],
  afterId: string,
  answers: Answers,
  flags: string[],
): PlanStep | null {
  const index = plan.findIndex((step) => step.id === afterId);
  if (index === -1) throw new Error(`No step "${afterId}" in the plan`);
  const rest = plan.slice(index + 1);
  return (
    rest.find((step) => !step.when || evaluate(step.when, answers, flags)) ??
    null
  );
}

/** Why a proposed step can't join the plan, or null if it can. */
export function validatePlanStep(
  step: PlanStep,
  takenIds: string[],
): string | null {
  if (takenIds.includes(step.id)) return `Duplicate step id "${step.id}"`;
  const type = stageTypeOf(step.type);
  if (!type) return `Unknown stage type "${step.type}"`;
  if (!STAGES[type].params.safeParse(step.params ?? {}).success) {
    return `Bad params for step "${step.id}" (${step.type})`;
  }
  return null;
}

/** Why a batch of proposed steps is refused, or null if all are fine. */
export function validateAppend(
  plan: PlanStep[],
  steps: PlanStep[],
): string | null {
  if (plan.length + steps.length > MAX_PLAN_STEPS) {
    return `More than ${MAX_PLAN_STEPS} steps in the plan`;
  }
  const takenIds = plan.map((step) => step.id);
  for (const step of steps) {
    const problem = validatePlanStep(step, takenIds);
    if (problem) return problem;
    takenIds.push(step.id);
  }
  return null;
}
