// Adding a firm. Firms aren't self-serve: someone checks who they are and
// where they may practice, then adds them here, e.g.
// `npx convex run easygov/firms/data:createFirm '{...}'`.
import { ConvexError, v, type ObjectType } from "convex/values";
import { internalMutation } from "../../_generated/server";
import { logCaseEvent, writeCase } from "../case/data";
import { parseJurisdiction } from "../packs/schema";
import { firmFields, OPEN_DAYS } from "./schema";

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

/** How many referrals one run expires. The cron comes round again. */
const EXPIRE_BATCH = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Takes back the shared cases no firm accepted within `OPEN_DAYS`, oldest
 * first. The case says so, in its referral and its history, so the person
 * isn't left waiting on nobody: they can ask again, or carry on alone.
 * Returns how many expired.
 */
export const expireReferrals = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const cutoff = Date.now() - OPEN_DAYS * DAY_MS;
    const waiting = await ctx.db
      .query("referrals")
      .withIndex("by_status", (q) =>
        q.eq("status", "open").lt("_creationTime", cutoff),
      )
      .take(EXPIRE_BATCH);
    for (const referral of waiting) {
      await ctx.db.replace("referrals", referral._id, {
        ...referral,
        status: "expired",
      });
      const { caseId, kind } = referral;
      const found = await ctx.db.get("cases", caseId);
      // Only if this is still the referral the case speaks of.
      if (
        found?.referral?.kind === kind &&
        found.referral.status === "shared"
      ) {
        await writeCase(ctx, caseId, { referral: { kind, status: "expired" } });
      }
      if (found) await logCaseEvent(ctx, caseId, "referral.expired", kind);
    }
    return waiting.length;
  },
});
