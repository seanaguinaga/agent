// The profile's store, and how it meets a case.
//
// A case's `answers` are always what its document is built from. The ones
// read from the profile are listed in `fromProfile`: they follow the profile
// until the person approves, and an answer the person gives on the case
// itself stops following. After approval nothing here touches the case, so
// it keeps what it was built from.
import type { Id } from "../../_generated/dataModel";
import { internal } from "../../_generated/api";
import {
  internalMutation,
  type MutationCtx,
  type QueryCtx,
} from "../../_generated/server";
import { writeCase } from "../case/data";
import { pinnedPack, reviewOutcome, type Case } from "../case/state";
import { nudgeCase } from "../case/workflow";
import { ConvexError, v } from "convex/values";
import {
  checkFact,
  FACT_KEYS,
  FACTS,
  READINGS,
  isReading,
  nameFromText,
  type Fact,
  type FactKey,
  type Facts,
  type FactValue,
} from "./vocabulary";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A person's facts as they stand, and when each was last confirmed. */
export async function currentFacts(
  ctx: QueryCtx,
  userId: string,
): Promise<{ facts: Facts; at: Partial<Record<FactKey, number>> }> {
  const facts: Facts = {};
  const at: Partial<Record<FactKey, number>> = {};
  for (const key of FACT_KEYS) {
    const row = await ctx.db
      .query("profileFacts")
      .withIndex("by_userId_and_key", (q) =>
        q.eq("userId", userId).eq("key", key),
      )
      .order("desc")
      .first();
    if (row) {
      facts[key] = row.value;
      at[key] = row._creationTime;
    }
  }
  return { facts, at };
}

/** True when a fact is old enough that the person should be asked again. */
export function isStale(key: FactKey, at: number, now: number): boolean {
  const fact: Fact = FACTS[key];
  return (
    fact.staleAfterDays !== undefined && now - at > fact.staleAfterDays * DAY_MS
  );
}

/**
 * Saves a fact, and lets the person's open cases pick it up a moment later.
 * Throws what's wrong with the value, in words for the person.
 */
export async function saveFact(
  ctx: MutationCtx,
  userId: string,
  key: FactKey,
  value: FactValue,
): Promise<void> {
  const checked = checkFact(key, value);
  if ("problem" in checked) throw new ConvexError(checked.problem);
  await ctx.db.insert("profileFacts", { userId, key, value: checked.value });
  await scheduleSync(ctx, userId);
}

/**
 * Lets a person's other open cases pick up a change to their profile, soon
 * after. Not in this transaction: a mutation that wrote every one of their
 * cases would collide with whatever those cases are doing.
 */
export async function scheduleSync(
  ctx: MutationCtx,
  userId: string,
): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.easygov.profile.data.fanOutSync, {
    userId,
  });
}

/** Schedules a re-read of the profile into each of a person's open cases. */
export const fanOutSync = internalMutation({
  args: { userId: v.string() },
  returns: v.null(),
  handler: async (ctx, { userId }) => {
    const cases = await ctx.db
      .query("cases")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .order("desc")
      .take(50);
    for (const c of cases) {
      if (c.status !== "active") continue;
      // One case to a transaction, so they don't wait on each other.
      await ctx.scheduler.runAfter(0, internal.easygov.profile.data.syncOne, {
        caseId: c._id,
      });
    }
    return null;
  },
});

/** Re-reads the profile into one case. */
export const syncOne = internalMutation({
  args: { caseId: v.id("cases") },
  returns: v.null(),
  handler: async (ctx, { caseId }) => {
    await syncCase(ctx, caseId);
    return null;
  },
});

/**
 * Re-reads the profile into one case: fills what the pack reads from it,
 * and offers back what needs a look (an old address, last time's answer).
 * Does nothing to a case that has ended or been approved.
 */
export async function syncCase(
  ctx: MutationCtx,
  caseId: Id<"cases">,
): Promise<void> {
  const c = await ctx.db.get("cases", caseId);
  const pack = c && pinnedPack(c);
  if (!c || !pack || c.status !== "active") return;
  if (reviewOutcome(c) === "approved") return;

  const { facts, at } = await currentFacts(ctx, c.userId);
  const now = Date.now();
  const answers = { ...c.answers };
  const following = new Set(c.fromProfile ?? []);
  const offers: Record<string, string> = {};
  const read = (key: string): string | undefined =>
    isReading(key) ? READINGS[key].read(facts) : undefined;

  for (const key of pack.inputs) {
    if (isReading(key)) {
      // An answer given on the case itself is the case's own.
      if (answers[key] !== undefined && !following.has(key)) continue;
      const value = read(key);
      if (value === undefined) {
        if (following.delete(key)) delete answers[key];
        continue;
      }
      const fact = READINGS[key].fact;
      // An old address is offered back, not filled in: "still right?".
      if (!following.has(key) && isStale(fact, at[fact] ?? now, now)) {
        offers[key] = value;
        continue;
      }
      answers[key] = value;
      following.add(key);
      continue;
    }
    if (answers[key] !== undefined) continue;
    // Something this pack asked last time, or a reading the pack points at
    // ("your old address" starts as today's home address).
    const link = pack.profile?.find((entry) => entry.input === key);
    const remembered = pack.id
      ? await ctx.db
          .query("rememberedAnswers")
          .withIndex("by_userId_and_packId_and_key", (q) =>
            q.eq("userId", c.userId).eq("packId", pack.id).eq("key", key),
          )
          .order("desc")
          .first()
      : null;
    const offered = (link?.reads && read(link.reads)) || remembered?.value;
    if (offered) offers[key] = offered;
  }

  const fromProfile = [...following].sort();
  if (
    JSON.stringify([answers, fromProfile, offers]) ===
    JSON.stringify([
      c.answers,
      [...(c.fromProfile ?? [])].sort(),
      c.offers ?? {},
    ])
  ) {
    return;
  }
  await writeCase(ctx, caseId, { answers, fromProfile, offers });
  await nudgeCase(ctx, c);
}

/**
 * Keeps an answer the person gave on a case, for next time. A profile fact
 * typed as plain text is saved to the profile when there's no doubt what it
 * means; anything else is remembered against the pack that asked.
 * Returns true when it went to the profile, so the case follows it.
 */
export async function keepAnswer(
  ctx: MutationCtx,
  c: Case,
  key: string,
  value: string,
): Promise<boolean> {
  if (isReading(key)) {
    const { fact } = READINGS[key];
    // Text facts are their own reading; a two-word name has one reading.
    const parsed: FactValue | undefined =
      key === fact &&
      FACTS[fact].kind !== "address" &&
      FACTS[fact].kind !== "name"
        ? value
        : key === "fullName"
          ? nameFromText(value)
          : undefined;
    if (parsed === undefined) return false;
    const checked = checkFact(fact, parsed);
    if ("problem" in checked) return false;
    await ctx.db.insert("profileFacts", {
      userId: c.userId,
      key: fact,
      value: checked.value,
    });
    return true;
  }
  const pack = pinnedPack(c);
  const question =
    pack?.inputQuestions?.find((asked) => asked.key === key)?.question ?? key;
  await ctx.db.insert("rememberedAnswers", {
    userId: c.userId,
    packId: pack?.id,
    key,
    question,
    value,
    caseId: c._id,
  });
  return false;
}

/** What the person answered on other packs, newest first, for prefill. */
export async function rememberedElsewhere(
  ctx: QueryCtx,
  c: Case,
): Promise<{ question: string; answer: string }[]> {
  const rows = await ctx.db
    .query("rememberedAnswers")
    .withIndex("by_userId", (q) => q.eq("userId", c.userId))
    .order("desc")
    .take(40);
  const seen = new Set<string>();
  return rows
    .filter((row) => row.caseId !== c._id)
    .filter((row) => !seen.has(row.question) && seen.add(row.question))
    .slice(0, 20)
    .map(({ question, value }) => ({ question, answer: value }));
}
