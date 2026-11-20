import { vArtifact } from "../case/schema";
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
import { today } from "../dates";
import { covers, vCoverage, vStage } from "./schema";

const DAY_MS = 24 * 60 * 60 * 1000;
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
  evidence: v.number(),
  priceCents: v.number(),
  /** How far the case had got when it was shared. */
  stage: vStage,
  /** The amount at stake, in a band: never the figure. */
  amountBand: v.optional(v.string()),
  /** Days until the date to act by; negative once it has passed. */
  daysLeft: v.optional(v.number()),
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
async function rejected(
  ctx: QueryCtx,
  firmId: Id<"firms">,
  referralId: Id<"referrals">,
): Promise<Doc<"referralRejections"> | null> {
  return await ctx.db
    .query("referralRejections")
    .withIndex("by_firmId_and_referralId", (q) =>
      q.eq("firmId", firmId).eq("referralId", referralId),
    )
    .first();
}

/** The firms the signed-in account acts for. */
export const listFirms = query({
  args: {},
  returns: v.array(
    v.object({
      id: v.id("firms"),
      name: v.string(),
      coverage: v.array(vCoverage),
    }),
  ),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError("Sign in first.");
    const rows = await ctx.db
      .query("firms")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .take(MAX_PREVIEWS);
    return rows.map(({ _id, name, coverage }) => ({ id: _id, name, coverage }));
  },
});

/** The open referrals the firm covers and hasn't passed on, oldest first. */
export const listPreviews = query({
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
        if (await rejected(ctx, firmId, row._id)) continue;
        found.set(row._id, row);
        kept++;
      }
    }
    const open = [...found.values()]
      .sort((a, b) => a._creationTime - b._creationTime)
      .slice(0, MAX_PREVIEWS);
    const now = today(Date.now());
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
          ...new Set(
            referral.evidence.flatMap(({ key }) => (key ? [key] : [])),
          ),
        ].sort(),
        evidence: referral.evidence.length,
        priceCents: referral.priceCents,
        stage: referral.stage ?? "accepted",
        amountBand: referral.amountBand,
        daysLeft:
          referral.deadline === undefined
            ? undefined
            : Math.round(
                (Date.parse(referral.deadline) - Date.parse(now)) / DAY_MS,
              ),
      });
    }
    return previews;
  },
});

/**
 * Takes a referral. The first firm to accept gets it, owes its price, and
 * can then read it with `getPacket`.
 */
export const acceptReferral = mutation({
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
    const passed = await rejected(ctx, firmId, referralId);
    if (passed) await ctx.db.delete("referralRejections", passed._id);
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
export const rejectReferral = mutation({
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
    if (!(await rejected(ctx, firmId, referralId))) {
      await ctx.db.insert("referralRejections", { firmId, referralId });
    }
    return null;
  },
});

/** The referrals the firm accepted, newest first. */
export const listAccepted = query({
  args: { firmId: v.id("firms") },
  returns: v.array(
    v.object({
      id: v.id("referrals"),
      kind: v.string(),
      /** What the person wants done, and the process they completed. */
      goal: v.string(),
      process: v.optional(v.string()),
      jurisdiction: v.optional(v.string()),
      deadline: v.optional(v.string()),
      priceCents: v.number(),
      /** Questions the firm asked that the person hasn't answered yet. */
      unanswered: v.number(),
    }),
  ),
  handler: async (ctx, { firmId }) => {
    await authorizeFirm(ctx, firmId);
    const rows = await ctx.db
      .query("referrals")
      .withIndex("by_firmId", (q) => q.eq("firmId", firmId))
      .order("desc")
      .take(MAX_PREVIEWS);
    const accepted = [];
    for (const row of rows) {
      const pack =
        row.process === undefined && row.packId
          ? await ctx.db.get("processPacks", row.packId)
          : null;
      const asked = await ctx.db
        .query("referralQuestions")
        .withIndex("by_referralId", (q) => q.eq("referralId", row._id))
        .take(MAX_PREVIEWS);
      accepted.push({
        id: row._id,
        kind: row.kind,
        goal: row.goal,
        process: row.process ?? pack?.title,
        jurisdiction: row.jurisdiction,
        deadline: row.deadline,
        priceCents: row.priceCents,
        unanswered: asked.filter(({ answer }) => answer === undefined).length,
      });
    }
    return accepted;
  },
});

/**
 * Everything the person agreed to share, for the firm that accepted it:
 * their goal, answers, files and the date to act by.
 */
export const getPacket = query({
  args: { firmId: v.id("firms"), referralId: v.id("referrals") },
  returns: v.object({
    questions: v.optional(
      v.array(
        v.object({ question: v.string(), answer: v.optional(v.string()) }),
      ),
    ),
    artifact: v.optional(vArtifact),
    documentUrls: v.optional(v.record(v.string(), v.string())),
    kind: v.string(),
    userId: v.string(),
    goal: v.string(),
    process: v.optional(v.string()),
    jurisdiction: v.optional(v.string()),
    deadline: v.optional(v.string()),
    answers: v.record(v.string(), v.string()),
    /** Each attached file, with a link to it and what reading it found. */
    evidence: v.array(
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
    const evidence = [];
    for (const { storageId, ...file } of referral.evidence) {
      const url = await ctx.storage.getUrl(storageId);
      if (url) evidence.push({ ...file, url });
    }
    const rows = await ctx.db
      .query("referralQuestions")
      .withIndex("by_referralId", (q) => q.eq("referralId", referralId))
      .order("desc")
      .take(50);
    const questions = rows.map(({ question, answer }) => ({
      question,
      answer,
    }));
    const artifact = referral.artifact;
    const documentUrls: Record<string, string> = {};
    for (const doc of [
      ...(artifact?.documents ?? []),
      ...(artifact?.document ? [artifact.document] : []),
    ]) {
      const url = await ctx.storage.getUrl(doc.storageId);
      if (url) documentUrls[doc.storageId] = url;
    }
    const { kind, userId, goal, jurisdiction, deadline, answers } = referral;
    return {
      kind,
      userId,
      goal,
      ...(artifact && { artifact, documentUrls }),
      ...(questions.length > 0 && { questions }),
      process: referral.process ?? pack?.title,
      jurisdiction,
      deadline,
      answers,
      evidence,
    };
  },
});

/**
 * What the firm owes: one charge for each referral it accepted, newest
 * first. A statement only: no payment is taken here.
 */
export const listCharges = query({
  args: { firmId: v.id("firms") },
  returns: v.object({
    owedCents: v.number(),
    charges: v.array(
      v.object({
        referralId: v.id("referrals"),
        at: v.number(),
        amountCents: v.number(),
        status: v.literal("owed"),
      }),
    ),
  }),
  handler: async (ctx, { firmId }) => {
    await authorizeFirm(ctx, firmId);
    const rows = await ctx.db
      .query("referralCharges")
      .withIndex("by_firmId", (q) => q.eq("firmId", firmId))
      .order("desc")
      .take(200);
    return {
      owedCents: rows.reduce((sum, row) => sum + row.amountCents, 0),
      charges: rows.map(
        ({ referralId, _creationTime, amountCents, status }) => ({
          referralId,
          at: _creationTime,
          amountCents,
          status,
        }),
      ),
    };
  },
});

export const requestInformation = mutation({
  args: {
    firmId: v.id("firms"),
    referralId: v.id("referrals"),
    question: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, { firmId, referralId, question }) => {
    await authorizeFirm(ctx, firmId);
    const referral = await ctx.db.get("referrals", referralId);
    if (referral?.status !== "accepted" || referral.firmId !== firmId)
      throw new ConvexError("Referral not found.");
    if (!question.trim() || question.length > 3000)
      throw new ConvexError("Enter a question of up to 3,000 characters.");
    await ctx.db.insert("referralQuestions", {
      referralId,
      caseId: referral.caseId,
      question: question.trim(),
    });
    return null;
  },
});
