// The legalReferral stage: opens a referral for someone else to pick up. The
// case doesn't wait for it.
import { v } from "convex/values";
import { z } from "zod/v4";
import { internal } from "../../../_generated/api";
import { internalMutation } from "../../../_generated/server";
import { defineStage } from "../../stage";
import type { StageResult } from "../../validators";

export const legalReferralParams = z.strictObject({ kind: z.string() });

export const open = internalMutation({
  args: { caseId: v.id("cases"), kind: v.string() },
  returns: v.null(),
  handler: async (ctx, { caseId, kind }) => {
    const found = await ctx.db.get("cases", caseId);
    if (!found) return null;
    // The step can run again after a retry: one referral per kind is enough.
    const existing = await ctx.db
      .query("referrals")
      .withIndex("by_caseId_and_kind", (q) =>
        q.eq("caseId", caseId).eq("kind", kind),
      )
      .first();
    if (!existing) {
      await ctx.db.insert("referrals", {
        caseId,
        userId: found.userId,
        kind,
        status: "open",
      });
    }
    return null;
  },
});

export const run = defineStage(
  async (step, { caseId, params }): Promise<StageResult> => {
    const { kind } = legalReferralParams.parse(params ?? {});
    await step.runMutation(
      internal.easygov.stages.legalReferral.legalReferral.open,
      {
        caseId,
        kind,
      },
    );
    return { outcome: "done" };
  },
);
