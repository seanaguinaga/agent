// The collect stage: waits until the case has every answer its pack requires.
import { ConvexError, v } from "convex/values";
import { z } from "zod/v4";
import { internal } from "../../../_generated/api";
import { internalQuery } from "../../../_generated/server";
import { missingInputs } from "../../answers";
import { getPack } from "../../packs";
import { defineStage, waitFor, type Case, type StageEvents } from "../../stage";
import { vStageResult, type StageResult } from "../../validators";

export const collectParams = z.strictObject({});

/** Sets one answer. Review takes this too, so editing sends it back. */
export function setAnswer(
  found: Case,
  { key, value }: { key: string; value: string },
): Partial<Case> {
  if (!getPack(found.processKey)?.inputs.includes(key)) {
    throw new ConvexError(`"${key}" isn't one of this case's inputs.`);
  }
  return { answers: { ...found.answers, [key]: value } };
}

/** What a person can send: one answer at a time. */
export const collectEvents = {
  "answers.set": setAnswer,
} satisfies StageEvents;

export const run = defineStage(
  (step, { caseId }): Promise<StageResult> =>
    waitFor(step, () =>
      step.runQuery(internal.easygov.stages.collect.collect.check, { caseId }),
    ),
);

export const check = internalQuery({
  args: { caseId: v.id("cases") },
  returns: v.union(vStageResult, v.null()),
  handler: async (ctx, { caseId }): Promise<StageResult | null> => {
    const found = await ctx.db.get("cases", caseId);
    const pack = getPack(found?.processKey);
    if (!found || !pack) return { outcome: "stop", reason: "No process" };
    const missing = missingInputs(pack.inputs, found.answers);
    return missing.length === 0 ? { outcome: "done" } : null;
  },
});
