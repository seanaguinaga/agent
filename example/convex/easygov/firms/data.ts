// Adding a firm. Firms aren't self-serve: someone checks who they are and
// where they may practice, then adds them here, e.g.
// `npx convex run easygov/firms/data:createFirm '{...}'`.
import { ConvexError, v, type ObjectType } from "convex/values";
import { internalMutation } from "../../_generated/server";
import { parseJurisdiction } from "../packs/schema";
import { firmFields } from "./schema";

/** Few enough kinds and places that a firm's coverage reads at a glance. */
const MAX_COVERAGE = 20;

/** A firm's name, account and coverage, checked and tidied. */
function checkFirm({ name, userId, coverage }: ObjectType<typeof firmFields>) {
  if (!name.trim() || !userId.trim()) {
    throw new ConvexError("A firm needs a name and an account.");
  }
  if (!coverage.length || coverage.length > MAX_COVERAGE) {
    throw new ConvexError(`List 1 to ${MAX_COVERAGE} kinds of referral.`);
  }
  const checked = coverage.map(({ kind, jurisdiction }) => {
    const place = parseJurisdiction(jurisdiction);
    if (!kind.trim() || !place) {
      throw new ConvexError(
        'Each kind needs a jurisdiction path such as "us" or "us/ca".',
      );
    }
    return { kind: kind.trim(), jurisdiction: place };
  });
  return { name: name.trim(), userId, coverage: checked };
}

/** Adds a reviewed firm. */
export const createFirm = internalMutation({
  args: firmFields,
  returns: v.id("firms"),
  handler: async (ctx, firm) => await ctx.db.insert("firms", checkFirm(firm)),
});

/** Replaces a firm's name, account and coverage. */
export const updateFirm = internalMutation({
  args: { firmId: v.id("firms"), ...firmFields },
  returns: v.null(),
  handler: async (ctx, { firmId, ...firm }) => {
    if (!(await ctx.db.get("firms", firmId))) {
      throw new ConvexError("Firm not found.");
    }
    await ctx.db.replace("firms", firmId, checkFirm(firm));
    return null;
  },
});
