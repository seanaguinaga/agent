// What a client does with a profile: read it, save a fact, see what's worth
// asking now, act on what a finished case suggests, and forget it all.
//
// Saving a fact needs no case and no pack. That's the point: a person can
// fill this in while their case is still being worked out, and whatever
// form turns up reads it.
import { ConvexError, v } from "convex/values";
import { mutation, query } from "../../_generated/server";
import { caller } from "../case/public";
import { pinnedPack } from "../case/state";
import { currentFacts, isStale, saveFact } from "./data";
import {
  FACT_KEYS,
  FACTS,
  factsRead,
  isFactKey,
  READINGS,
  vFactValue,
  type FactKey,
} from "./vocabulary";

const vFactKey = v.string();

function factKey(key: string): FactKey {
  if (!isFactKey(key)) throw new ConvexError(`"${key}" isn't a profile fact.`);
  return key;
}

/** The person's facts, every reading of them, and what cases suggest. */
export const getProfile = query({
  args: { guestKey: v.optional(v.string()) },
  returns: v.object({
    facts: v.array(
      v.object({
        key: vFactKey,
        label: v.string(),
        kind: v.string(),
        value: v.optional(vFactValue),
        /** When it was last confirmed. */
        at: v.optional(v.number()),
        /** Old enough that it's worth asking "still right?". */
        stale: v.boolean(),
      }),
    ),
    /** Every reading that has a value, by its key. */
    readings: v.record(v.string(), v.string()),
    proposals: v.array(
      v.object({
        id: v.id("profileProposals"),
        fact: vFactKey,
        label: v.string(),
        text: v.string(),
      }),
    ),
  }),
  handler: async (ctx, { guestKey }) => {
    const userId = await caller(ctx, guestKey);
    const { facts, at } = await currentFacts(ctx, userId);
    const now = Date.now();
    const readings: Record<string, string> = {};
    for (const [key, reading] of Object.entries(READINGS)) {
      const value = reading.read(facts);
      if (value !== undefined) readings[key] = value;
    }
    const open = await ctx.db
      .query("profileProposals")
      .withIndex("by_userId_and_status", (q) =>
        q.eq("userId", userId).eq("status", "open"),
      )
      .order("desc")
      .take(20);
    return {
      facts: FACT_KEYS.map((key) => ({
        key,
        label: FACTS[key].label,
        kind: FACTS[key].kind,
        value: facts[key],
        at: at[key],
        stale: at[key] !== undefined && isStale(key, at[key], now),
      })),
      readings,
      proposals: open.flatMap((row) =>
        isFactKey(row.fact)
          ? [
              {
                id: row._id,
                fact: row.fact,
                label: FACTS[row.fact].label,
                text: row.text,
              },
            ]
          : [],
      ),
    };
  },
});

/** Saves one fact. The person's open cases pick it up at once. */
export const setFact = mutation({
  args: { key: vFactKey, value: vFactValue, guestKey: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { key, value, guestKey }) => {
    const userId = await caller(ctx, guestKey);
    await saveFact(ctx, userId, factKey(key), value);
    return null;
  },
});

/** How many facts to ask for ahead of a form that isn't known yet. */
const ASK_AHEAD = 3;
/** With no packs to count, what nearly every form and letter uses. */
const USUAL: FactKey[] = ["name", "mailingAddress", "phone"];

/**
 * The facts worth asking for now, most certain first, leaving out what's
 * already known and fresh.
 *
 * - With a case on a confirmed pack: exactly what that pack reads. Certain.
 * - Otherwise: what the saved packs read most often. That's a measurement of
 *   our own library, not a guess, and it stops as soon as the pack is known.
 *
 * Everything asked ahead is optional, and none of it is wasted: it's there
 * for the next form.
 */
export const askAhead = query({
  args: { caseId: v.optional(v.id("cases")), guestKey: v.optional(v.string()) },
  returns: v.array(
    v.object({
      fact: vFactKey,
      label: v.string(),
      /** "needed": the confirmed pack reads it. "likely": most packs do. */
      why: v.union(v.literal("needed"), v.literal("likely")),
    }),
  ),
  handler: async (ctx, { caseId, guestKey }) => {
    const userId = await caller(ctx, guestKey);
    const { facts, at } = await currentFacts(ctx, userId);
    const now = Date.now();
    const unknown = (key: FactKey) =>
      facts[key] === undefined || isStale(key, at[key] ?? now, now);
    const found = caseId ? await ctx.db.get("cases", caseId) : null;
    const pack = found?.userId === userId ? pinnedPack(found) : undefined;
    if (pack) {
      return factsRead(pack.inputs)
        .filter(unknown)
        .map((fact) => ({
          fact,
          label: FACTS[fact].label,
          why: "needed" as const,
        }));
    }
    const shared = await ctx.db
      .query("processPacks")
      .withIndex("by_ownerId_and_status", (q) =>
        q.eq("ownerId", undefined).eq("status", "current"),
      )
      .take(200);
    const uses = new Map<FactKey, number>();
    for (const { inputs } of shared) {
      for (const fact of factsRead(inputs)) {
        uses.set(fact, (uses.get(fact) ?? 0) + 1);
      }
    }
    const ranked = [
      ...[...uses].sort(([, a], [, b]) => b - a).map(([fact]) => fact),
      ...USUAL,
    ];
    return [...new Set(ranked)]
      .filter(unknown)
      .slice(0, ASK_AHEAD)
      .map((fact) => ({
        fact,
        label: FACTS[fact].label,
        why: "likely" as const,
      }));
  },
});

/**
 * Settles what a finished case suggested. Accepting doesn't save anything by
 * itself: the person confirms the fact's parts with `setFact` first, since the
 * case only has what they typed there.
 */
export const settleProposal = mutation({
  args: {
    id: v.id("profileProposals"),
    accept: v.boolean(),
    guestKey: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { id, accept, guestKey }) => {
    const userId = await caller(ctx, guestKey);
    const row = await ctx.db.get("profileProposals", id);
    if (!row || row.userId !== userId) throw new ConvexError("Not found.");
    if (row.status !== "open") return null;
    await ctx.db.replace("profileProposals", id, {
      ...row,
      status: accept ? "accepted" : "dismissed",
    });
    return null;
  },
});

/** How many rows one call removes. Call again until it returns false. */
const FORGET_BATCH = 200;

/**
 * Removes what's kept about the person apart from their cases: their facts,
 * remembered answers, and suggestions. Returns true if there's more to
 * remove. Cases keep the answers they were built from.
 */
export const deleteProfile = mutation({
  args: { guestKey: v.optional(v.string()) },
  returns: v.boolean(),
  handler: async (ctx, { guestKey }) => {
    const userId = await caller(ctx, guestKey);
    const facts = await ctx.db
      .query("profileFacts")
      .withIndex("by_userId_and_key", (q) => q.eq("userId", userId))
      .take(FORGET_BATCH);
    const remembered = await ctx.db
      .query("rememberedAnswers")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .take(FORGET_BATCH);
    const proposals = [];
    for (const status of ["open", "accepted", "dismissed"] as const) {
      proposals.push(
        ...(await ctx.db
          .query("profileProposals")
          .withIndex("by_userId_and_status", (q) =>
            q.eq("userId", userId).eq("status", status),
          )
          .take(FORGET_BATCH)),
      );
    }
    for (const row of facts) await ctx.db.delete("profileFacts", row._id);
    for (const row of remembered) {
      await ctx.db.delete("rememberedAnswers", row._id);
    }
    for (const row of proposals) {
      await ctx.db.delete("profileProposals", row._id);
    }
    return [facts, remembered, proposals].some(
      (rows) => rows.length === FORGET_BATCH,
    );
  },
});
