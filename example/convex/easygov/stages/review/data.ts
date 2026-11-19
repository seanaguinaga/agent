// What the review workflow reads.
import { v } from "convex/values";
import { internalQuery } from "../../../_generated/server";
import { fingerprint } from "../../case/answers";
import { vStageResult, type StageResult } from "../../case/schema";

/** Approved, or back when the answers changed; null keeps the workflow waiting. */
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
