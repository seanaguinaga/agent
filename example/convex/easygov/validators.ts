// Shapes shared by the plan (data), the stages (code) and the public API.
import { v, type Infer } from "convex/values";

const vLeafCondition = v.union(
  v.object({ input: v.string(), equals: v.string() }),
  v.object({ flag: v.string() }),
);

/**
 * A serializable condition for a plan step's `when`. Convex validators can't
 * be recursive, so `all` and `any` take leaf conditions only.
 */
export const vCondition = v.union(
  v.object({ input: v.string(), equals: v.string() }),
  v.object({ flag: v.string() }),
  v.object({ all: v.array(vLeafCondition) }),
  v.object({ any: v.array(vLeafCondition) }),
);
export type Condition = Infer<typeof vCondition>;

/** Stage params are flat strings; each stage type's zod schema narrows them. */
export const vParams = v.record(v.string(), v.string());

export const vPlanStep = v.object({
  id: v.string(),
  type: v.string(),
  params: v.optional(vParams),
  when: v.optional(vCondition),
});
export type PlanStep = Infer<typeof vPlanStep>;

/** What a stage workflow returns. `advance` decides what happens next. */
export const vStageResult = v.object({
  outcome: v.union(v.literal("done"), v.literal("back"), v.literal("stop")),
  /** For `back`: the id of the step to return to. */
  backTo: v.optional(v.string()),
  /** For `stop`: why, shown as the case's `endReason`. */
  reason: v.optional(v.string()),
  /** Steps to insert after this one. `advance` validates them. */
  append: v.optional(v.array(vPlanStep)),
});
export type StageResult = Infer<typeof vStageResult>;

/** The step `advance` hands to the parent workflow to run next. */
export const vNextStep = v.object({
  id: v.string(),
  type: v.string(),
  params: v.optional(vParams),
  visits: v.number(),
});
export type NextStep = Infer<typeof vNextStep>;

/** Everything a person can send to a case. */
export const vCaseEvent = v.union(
  v.object({ type: v.literal("intake.submit"), goal: v.string() }),
  v.object({ type: v.literal("route.confirm"), processKey: v.string() }),
  v.object({ type: v.literal("route.reject") }),
  v.object({
    type: v.literal("answers.set"),
    key: v.string(),
    value: v.string(),
  }),
  v.object({ type: v.literal("review.approve") }),
  v.object({ type: v.literal("step.retry") }),
  v.object({ type: v.literal("step.cancel") }),
  v.object({ type: v.literal("case.cancel") }),
);
export type CaseEvent = Infer<typeof vCaseEvent>;
