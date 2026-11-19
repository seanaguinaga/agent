// The review stage: waits for the person to approve the artifact, or to
// change an answer.
import { ConvexError, v } from "convex/values";
import { z } from "zod/v4";
import { internal } from "../../../_generated/api";
import { internalQuery } from "../../../_generated/server";
import { fingerprint } from "../../answers";
import { defineStage, waitFor, type StageEvents } from "../../stage";
import { vStageResult, type StageResult } from "../../validators";
import { setAnswer } from "../collect/collect";

/** `backTo`: the step to return to when an answer changes. */
export const reviewParams = z.strictObject({ backTo: z.string() });

/** What a person can send: approve, or change an answer. */
export const reviewEvents = {
  "answers.set": setAnswer,
  "review.approve": (found) => {
    const current = fingerprint(found.answers);
    if (found.artifact?.fingerprint !== current) {
      throw new ConvexError("The answers changed. Review the new version.");
    }
    return { approval: { fingerprint: current } };
  },
} satisfies StageEvents;

export const run = defineStage(
  (step, { caseId, params }): Promise<StageResult> => {
    const { backTo } = reviewParams.parse(params ?? {});
    return waitFor(step, () =>
      step.runQuery(internal.easygov.stages.review.review.check, {
        caseId,
        backTo,
      }),
    );
  },
);

export const check = internalQuery({
  args: { caseId: v.id("cases"), backTo: v.string() },
  returns: v.union(vStageResult, v.null()),
  handler: async (ctx, { caseId, backTo }): Promise<StageResult | null> => {
    const found = await ctx.db.get("cases", caseId);
    if (!found) return { outcome: "stop", reason: "No case" };
    const { artifact, approval, answers } = found;
    // The answers changed since the artifact was made: collect and fill again.
    if (artifact?.fingerprint !== fingerprint(answers)) {
      return { outcome: "back", backTo };
    }
    return approval?.fingerprint === artifact.fingerprint
      ? { outcome: "done" }
      : null;
  },
});
