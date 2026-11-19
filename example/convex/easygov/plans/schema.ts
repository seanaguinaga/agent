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
