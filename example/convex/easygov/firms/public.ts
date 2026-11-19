// What a law firm does: see the referrals it could take, without the
// person's details; accept one or pass on it; and read the one it accepted.
//
// A referral goes to one firm: the first to accept it. Accepting is what
// reveals the answers and files, and what the firm owes for.
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../../_generated/dataModel";
import { mutation, query, type QueryCtx } from "../../_generated/server";
import { getAuthUserId } from "../../utils";
import { logCaseEvent } from "../case/data";
import { covers } from "./schema";

/** At most this many previews: enough to choose from, and a bounded read. */
const MAX_PREVIEWS = 50;
/** How far one kind's open referrals are read to find that many. */
const MAX_SCANNED = 200;

/**
 * A referral as a firm sees it before accepting: what it's about and how
 * complete it is, and nothing the person wrote.
 */
const vPreview = v.object({
  id: v.id("referrals"),
  kind: v.string(),
  jurisdiction: v.string(),
  /** The process the person completed; none for a request for advice. */
  process: v.optional(v.string()),
  deadline: v.optional(v.string()),
  /** Which questions were answered and which asked-for files attached, by key. */
  answered: v.array(v.string()),
  attached: v.array(v.string()),
  /** How many files there are in all, with any other evidence. */
  files: v.number(),
  priceCents: v.number(),
});

/** The firm, if the signed-in account acts for it. */
async function authorizeFirm(
  ctx: QueryCtx,
  firmId: Id<"firms">,
): Promise<Doc<"firms">> {
  const userId = await getAuthUserId(ctx);
  const firm = userId ? await ctx.db.get("firms", firmId) : null;
  if (!firm || firm.userId !== userId) throw new ConvexError("Firm not found.");
  return firm;
}

/** The record that the firm passed on the referral, if it did. */
async function declined(
  ctx: QueryCtx,
  firmId: Id<"firms">,
  referralId: Id<"referrals">,
): Promise<Doc<"referralDeclines"> | null> {
  return await ctx.db
    .query("referralDeclines")
    .withIndex("by_firmId_and_referralId", (q) =>
      q.eq("firmId", firmId).eq("referralId", referralId),
    )
    .first();
}

/** The open referrals the firm covers and hasn't passed on, oldest first. */
export const previews = query({
  args: { firmId: v.id("firms") },
  returns: v.array(vPreview),
  handler: async (ctx, { firmId }) => {
    const firm = await authorizeFirm(ctx, firmId);
    const found = new Map<Id<"referrals">, Doc<"referrals">>();
    for (const { kind, jurisdiction } of firm.coverage) {
      // "us/ca" and everything inside it sorts from "us/ca" up to "us/ca0"
      // ("0" follows "/"). So does "us/ca-x", which `covers` then drops.
      const rows = ctx.db
        .query("referrals")
        .withIndex("by_status_and_kind_and_jurisdiction", (q) =>
          q
            .eq("status", "open")
            .eq("kind", kind)
            .gte("jurisdiction", jurisdiction)
            .lt("jurisdiction", `${jurisdiction}0`),
        );
      // Reads past the ones the firm passed on, so they can't hide the rest.
      let kept = 0;
      let scanned = 0;
      for await (const row of rows) {
        if (kept === MAX_PREVIEWS || ++scanned > MAX_SCANNED) break;
        if (found.has(row._id) || !covers(firm.coverage, row)) continue;
        if (await declined(ctx, firmId, row._id)) continue;
        found.set(row._id, row);
        kept++;
      }
    }
    const open = [...found.values()]
      .sort((a, b) => a._creationTime - b._creationTime)
      .slice(0, MAX_PREVIEWS);
    const previews = [];
    for (const referral of open) {
      const pack = referral.packId
        ? await ctx.db.get("processPacks", referral.packId)
        : null;
      previews.push({
        id: referral._id,
        kind: referral.kind,
        jurisdiction: referral.jurisdiction!,
        process: pack?.title,
        deadline: referral.deadline,
        answered: Object.keys(referral.answers).sort(),
        attached: [
          ...new Set(referral.files.flatMap(({ key }) => (key ? [key] : []))),
        ].sort(),
        files: referral.files.length,
        priceCents: referral.priceCents,
      });
    }
    return previews;
  },
});

/**
 * Takes a referral. The first firm to accept gets it, owes its price, and
 * can then read it with `packet`.
 */
export const accept = mutation({
  args: { firmId: v.id("firms"), referralId: v.id("referrals") },
  returns: v.null(),
  handler: async (ctx, { firmId, referralId }) => {
    const firm = await authorizeFirm(ctx, firmId);
    const referral = await ctx.db.get("referrals", referralId);
    // A referral the firm doesn't cover is one it can't see: same answer.
    if (!referral || !covers(firm.coverage, referral)) {
      throw new ConvexError("Referral not found.");
    }
    if (referral.status !== "open") {
      throw new ConvexError("This referral is no longer available.");
    }
    await ctx.db.replace("referrals", referralId, {
      ...referral,
      status: "accepted",
      firmId,
    });
    // A firm that passed and now accepts changed its mind: it didn't pass.
    const passed = await declined(ctx, firmId, referralId);
    if (passed) await ctx.db.delete("referralDeclines", passed._id);
    await ctx.db.insert("referralCharges", {
      firmId,
      referralId,
      amountCents: referral.priceCents,
      status: "owed",
    });
    // The person's history says who has their case.
    await logCaseEvent(ctx, referral.caseId, "referral.accepted", firm.name);
    return null;
  },
});

/** Passes on a referral, so it isn't shown to this firm again. */
export const decline = mutation({
  args: { firmId: v.id("firms"), referralId: v.id("referrals") },
  returns: v.null(),
  handler: async (ctx, { firmId, referralId }) => {
    const firm = await authorizeFirm(ctx, firmId);
    const referral = await ctx.db.get("referrals", referralId);
    if (!referral || !covers(firm.coverage, referral)) {
      throw new ConvexError("Referral not found.");
    }
    // Only an open referral is anyone's to pass on: not one a firm has
    // taken (this firm included), or one the person took back.
    if (referral.status !== "open") {
      throw new ConvexError("This referral is no longer available.");
    }
    if (!(await declined(ctx, firmId, referralId))) {
      await ctx.db.insert("referralDeclines", { firmId, referralId });
    }
    return null;
  },
});

/** The referrals the firm accepted, newest first. */
export const accepted = query({
  args: { firmId: v.id("firms") },
  returns: v.array(
    v.object({
      id: v.id("referrals"),
      kind: v.string(),
      deadline: v.optional(v.string()),
      priceCents: v.number(),
    }),
  ),
  handler: async (ctx, { firmId }) => {
    await authorizeFirm(ctx, firmId);
    const rows = await ctx.db
      .query("referrals")
      .withIndex("by_firmId", (q) => q.eq("firmId", firmId))
      .order("desc")
      .take(MAX_PREVIEWS);
    return rows.map(({ _id, kind, deadline, priceCents }) => ({
      id: _id,
      kind,
      deadline,
      priceCents,
    }));
  },
});

/**
 * Everything the person agreed to share, for the firm that accepted it:
 * their goal, answers, files and the date to act by.
 */
export const packet = query({
  args: { firmId: v.id("firms"), referralId: v.id("referrals") },
  returns: v.object({
    kind: v.string(),
    userId: v.string(),
    goal: v.string(),
    process: v.optional(v.string()),
    jurisdiction: v.optional(v.string()),
    deadline: v.optional(v.string()),
    answers: v.record(v.string(), v.string()),
    /** Each attached file, with a link to it and what reading it found. */
    files: v.array(
      v.object({
        key: v.optional(v.string()),
        name: v.string(),
        mediaType: v.string(),
        size: v.number(),
        summary: v.optional(v.string()),
        url: v.string(),
      }),
    ),
  }),
  handler: async (ctx, { firmId, referralId }) => {
    await authorizeFirm(ctx, firmId);
    const referral = await ctx.db.get("referrals", referralId);
    if (referral?.status !== "accepted" || referral.firmId !== firmId) {
      throw new ConvexError("Referral not found.");
    }
    const pack = referral.packId
      ? await ctx.db.get("processPacks", referral.packId)
      : null;
    const files = [];
    for (const { storageId, ...file } of referral.files) {
      const url = await ctx.storage.getUrl(storageId);
      if (url) files.push({ ...file, url });
    }
    const { kind, userId, goal, jurisdiction, deadline, answers } = referral;
    return {
      kind,
      userId,
      goal,
      process: pack?.title,
      jurisdiction,
      deadline,
      answers,
      files,
    };
  },
});
