// What the legalReferral workflow writes: a row in `referrals`, nothing on the
// case.
import { v } from "convex/values";
import { internalMutation } from "../../../_generated/server";

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
