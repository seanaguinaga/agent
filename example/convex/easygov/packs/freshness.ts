// Keeping published packs fresh. A pack binds each of its forms to one file
// at one address. Authorities replace editions, move files and let them
// expire, so every current pack's forms are asked again on a schedule: the
// server mostly says "unchanged", which costs nothing. A pack whose file has
// changed, expired or gone is stale: operators see it in `stalePacks`, and a
// case built on it tells the person what to check before they file. A file
// on a site that is no longer vouched (see `forms/sites.ts`) isn't read, so
// its form counts as gone.
import { v } from "convex/values";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  query,
  type QueryCtx,
} from "../../_generated/server";
import { fileAt, newFinder } from "../case/locate";
import type { FileAnswer } from "../forms/actions";
import { vNamedBy } from "../forms/schema";
import { requireOperator } from "../operators";
import { vFormStanding } from "./schema";

/** How long a check stands before the pack is checked again. */
const CHECK_EVERY_MS = 7 * 24 * 60 * 60 * 1000;

/** As many packs as are looked at in one step of the scheduled sweep. */
const SWEEP_BATCH = 50;

/** How far apart the checks of one sweep start, so they don't all at once. */
const STAGGER_MS = 30_000;

type Standing = typeof vFormStanding.type;

/**
 * How a pack's form stands, from what its address answers now and the
 * edition the pack fills. Pure: the answer and the edition in, the standing
 * out.
 */
export function standingOf(
  answer: FileAnswer,
  editionId: Id<"formEditions"> | undefined,
): { standing: Standing; note?: string } {
  if (!answer.ok) {
    switch (answer.why) {
      case "gone":
      case "unusable":
      case "otherForm":
      case "page":
        return { standing: "lost", note: answer.note };
      case "unreachable":
      case "refused":
      case "busy":
      case "unspent":
        return { standing: "unchecked", note: answer.note };
    }
  }
  if (answer.facts.expired) return { standing: "expired" };
  if (editionId && answer.editionId !== editionId) {
    return { standing: "changed" };
  }
  return { standing: "current" };
}

/** What a person on a stale pack is told about one form, if anything. */
function standingNote(form: {
  code: string;
  sourceUrl: string;
  standing: Standing;
  note?: string;
}): string | undefined {
  const { code, sourceUrl } = form;
  switch (form.standing) {
    case "changed":
      return (
        `The authority has changed ${code} since this process was checked. ` +
        `Before you file, check that the copy in your packet matches the one at ${sourceUrl}.`
      );
    case "expired":
      return (
        `${code} prints an expiry date that has passed. ` +
        `Before you file, check the authority’s site for its current edition.`
      );
    case "lost":
      return (
        `${code} is no longer at ${sourceUrl}, where this process found it. ` +
        `Before you file, check the authority’s site for its current edition.`
      );
    case "current":
    case "unchecked":
      return undefined;
  }
}

const vStood = v.object({
  code: v.string(),
  sourceUrl: v.string(),
  standing: vFormStanding,
  note: v.optional(v.string()),
});

/** The last check of a pack, if it has been checked. */
const lastCheck = (ctx: QueryCtx, packId: Id<"processPacks">) =>
  ctx.db
    .query("packChecks")
    .withIndex("by_packId", (q) => q.eq("packId", packId))
    .unique();

/**
 * What a person on this pack should check before filing: a line for each
 * form its last check found changed, expired or gone.
 */
export async function stalenessOf(
  ctx: QueryCtx,
  packId: Id<"processPacks"> | undefined,
): Promise<string[]> {
  const check = packId && (await lastCheck(ctx, packId));
  if (!check?.stale) return [];
  return check.forms.flatMap((form) => standingNote(form) ?? []);
}

/**
 * The scheduled sweep: every current pack with forms whose last check is
 * older than `CHECK_EVERY_MS`, or that was never checked, is checked. It
 * goes through the packs a batch at a time.
 */
export const sweepPacks = internalMutation({
  args: { cursor: v.union(v.string(), v.null()) },
  returns: v.null(),
  handler: async (ctx, { cursor }) => {
    const { page, isDone, continueCursor } = await ctx.db
      .query("processPacks")
      .paginate({ numItems: SWEEP_BATCH, cursor });
    const now = Date.now();
    let due = 0;
    for (const pack of page) {
      if (pack.status !== "current") continue;
      if (!pack.packetForms?.some(({ sourceUrl }) => sourceUrl)) continue;
      const check = await lastCheck(ctx, pack._id);
      if (check && now - check.checkedAt < CHECK_EVERY_MS) continue;
      await ctx.scheduler.runAfter(
        due++ * STAGGER_MS,
        internal.easygov.packs.freshness.checkPack,
        { packId: pack._id },
      );
    }
    if (!isDone) {
      await ctx.scheduler.runAfter(
        due * STAGGER_MS,
        internal.easygov.packs.freshness.sweepPacks,
        { cursor: continueCursor },
      );
    }
    return null;
  },
});

/** A pack's forms with an address, and the edition each one fills. */
export const packForms = internalQuery({
  args: { packId: v.id("processPacks") },
  returns: v.union(
    v.null(),
    v.object({
      jurisdiction: v.string(),
      forms: v.array(
        v.object({
          code: v.string(),
          sourceUrl: v.string(),
          editionId: v.optional(v.id("formEditions")),
          namedBy: v.optional(vNamedBy),
        }),
      ),
    }),
  ),
  handler: async (ctx, { packId }) => {
    const pack = await ctx.db.get("processPacks", packId);
    if (!pack) return null;
    const forms = await Promise.all(
      (pack.packetForms ?? [])
        .filter(({ sourceUrl }) => sourceUrl)
        .map(async ({ code, sourceUrl, blueprintId, namedBy }) => {
          const blueprint =
            blueprintId && (await ctx.db.get("formBlueprints", blueprintId));
          return {
            code,
            sourceUrl,
            namedBy,
            ...(blueprint && { editionId: blueprint.editionId }),
          };
        }),
    );
    return { jurisdiction: pack.jurisdiction, forms };
  },
});

/** As much as checking one pack may spend. */
const CHECK_LIMITS = { downloads: 12, browser: 4 };

/** Asks each of a pack's form addresses again, and keeps how each stands. */
export const checkPack = internalAction({
  args: { packId: v.id("processPacks") },
  returns: v.null(),
  handler: async (ctx, { packId }) => {
    const pack = await ctx.runQuery(
      internal.easygov.packs.freshness.packForms,
      { packId },
    );
    if (!pack) return null;
    const finder = newFinder(CHECK_LIMITS);
    const forms = await Promise.all(
      pack.forms.map(async ({ code, sourceUrl, editionId, namedBy }) => {
        // The pack bound this address to the form when it was made: asked
        // again, its file still has to carry the form's number. One bound
        // on a trusted link alone still has to have no words to read.
        const answer = await fileAt(
          ctx,
          finder,
          {
            jurisdiction: pack.jurisdiction,
            code,
            linkedAs: code,
            trusted: namedBy === "link",
          },
          sourceUrl,
        );
        return { code, sourceUrl, ...standingOf(answer, editionId) };
      }),
    );
    await ctx.runMutation(internal.easygov.packs.freshness.recordCheck, {
      packId,
      forms,
    });
    return null;
  },
});

/** Keeps a pack's check, in place of the one before. */
export const recordCheck = internalMutation({
  args: { packId: v.id("processPacks"), forms: v.array(vStood) },
  returns: v.null(),
  handler: async (ctx, { packId, forms }) => {
    const check = {
      packId,
      forms,
      checkedAt: Date.now(),
      stale: forms.some((form) => standingNote(form) !== undefined),
    };
    const before = await lastCheck(ctx, packId);
    if (before) await ctx.db.replace("packChecks", before._id, check);
    else await ctx.db.insert("packChecks", check);
    return null;
  },
});

/** The packs whose last check found a form changed, expired or gone. */
export const stalePacks = query({
  args: {},
  returns: v.array(
    v.object({
      packId: v.id("processPacks"),
      title: v.string(),
      checkedAt: v.number(),
      forms: v.array(vStood),
    }),
  ),
  handler: async (ctx) => {
    await requireOperator(ctx);
    const checks = await ctx.db
      .query("packChecks")
      .withIndex("by_stale_and_checkedAt", (q) => q.eq("stale", true))
      .take(100);
    const rows = await Promise.all(
      checks.map(async ({ packId, checkedAt, forms }) => {
        const pack = await ctx.db.get("processPacks", packId);
        return pack?.status === "current"
          ? [{ packId, title: pack.title, checkedAt, forms }]
          : [];
      }),
    );
    return rows.flat();
  },
});
