// For the test pages in `ui/easygov`, and nothing else: seeding the fixture
// packs and a firm, and reading what the product API keeps to itself (every
// pack, a case's history, every referral).
//
// These are public and check nothing, which is fine while the example signs
// everyone in as the same test user. Don't ship this file.
import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { mutation, query } from "../_generated/server";
import { getAuthUserId } from "../utils";
import { phase, waitingFor } from "./case/state";
import { vHistoryKind, vPhase, vWaitingFor } from "./case/schema";
import { vCoverage } from "./firms/schema";
import { candidates, vSaveResult } from "./packs/data";
import { irs8822, ssaAppeal, wageClaim } from "./packs/packs.testkit";
import {
  jurisdictionChain,
  packDefinition,
  parseJurisdiction,
  vPackMatch,
  vProcessPackDefinition,
} from "./packs/schema";

const FIXTURES = { irs8822, ssaAppeal, wageClaim };
/** What the seeded firm takes: every referral the fixture packs can offer. */
const SEED_COVERAGE = [
  { kind: "representation", jurisdiction: "us" },
  { kind: "employment", jurisdiction: "us/ca" },
  { kind: "advice", jurisdiction: "us" },
];

/** The fixture packs, by name, for a page to show or edit before saving. */
export const fixtures = query({
  args: {},
  returns: v.record(v.string(), vProcessPackDefinition),
  handler: async () => FIXTURES,
});

/**
 * Saves the fixture packs as shared packs and a firm for the test user,
 * each only if it isn't there yet. Returns the pack id for each fixture.
 */
export const seed = mutation({
  args: {},
  returns: v.object({
    packs: v.record(v.string(), v.id("processPacks")),
    firmId: v.id("firms"),
  }),
  handler: async (ctx) => {
    const packs: Record<string, Id<"processPacks">> = {};
    for (const [name, definition] of Object.entries(FIXTURES)) {
      const shared = await ctx.db
        .query("processPacks")
        .withIndex("by_ownerId_and_status", (q) =>
          q.eq("ownerId", undefined).eq("status", "current"),
        )
        .take(200);
      const existing = shared.find((pack) => pack.title === definition.title);
      if (existing) {
        packs[name] = existing._id;
        continue;
      }
      // The fixtures are distinct processes: whatever looks similar has been
      // "reviewed". Each round can surface more, so go around a few times.
      const reviewedPackIds: Id<"processPacks">[] = [];
      for (let round = 0; !packs[name]; round++) {
        const saved = await ctx.runMutation(internal.easygov.packs.data.save, {
          ...definition,
          reviewedPackIds,
        });
        if (saved.kind === "created") packs[name] = saved.id;
        else if (round === 5) throw new Error(`Could not seed ${name}`);
        else reviewedPackIds.push(...saved.packs.map((pack) => pack.id));
      }
    }
    const userId = await getAuthUserId(ctx);
    const firm = await ctx.db
      .query("firms")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .first();
    const firmId: Id<"firms"> =
      firm?._id ??
      (await ctx.runMutation(internal.easygov.firms.data.save, {
        name: "Test & Partners",
        userId,
        coverage: SEED_COVERAGE,
      }));
    return { packs, firmId };
  },
});

// --- Packs ------------------------------------------------------------------

/** Every pack row, newest first: shared and owned, current and superseded. */
export const packs = query({
  args: {},
  returns: v.array(
    v.object({
      id: v.id("processPacks"),
      title: v.string(),
      jurisdiction: v.string(),
      status: v.union(v.literal("current"), v.literal("superseded")),
      ownerId: v.optional(v.string()),
      supersedes: v.optional(v.id("processPacks")),
      definition: vProcessPackDefinition,
    }),
  ),
  handler: async (ctx) => {
    const rows = await ctx.db.query("processPacks").order("desc").take(100);
    return rows.map((row) => {
      const { _id, _creationTime, ownerId, status, supersedes, ...rest } = row;
      const { searchText: _searchText, ...definition } = rest;
      return {
        id: _id,
        title: row.title,
        jurisdiction: row.jurisdiction,
        status,
        ownerId,
        supersedes,
        definition,
      };
    });
  },
});

/**
 * What selection's search finds for a request: current packs in the place
 * and the ones containing it, shared and (with `mine`) the test user's own.
 */
export const searchPacks = query({
  args: { jurisdiction: v.string(), terms: v.string(), mine: v.boolean() },
  returns: v.union(v.array(vPackMatch), v.null()),
  handler: async (ctx, { jurisdiction, terms, mine }) => {
    const place = parseJurisdiction(jurisdiction);
    if (!place) return null;
    const ownerId = mine ? await getAuthUserId(ctx) : undefined;
    return await candidates(ctx, jurisdictionChain(place), ownerId, terms);
  },
});

/** `packs/data:save` as it is, for trying duplicates and new versions. */
export const savePack = mutation({
  args: {
    ownerId: v.optional(v.string()),
    ...packDefinition,
    supersedes: v.optional(v.id("processPacks")),
    reviewedPackIds: v.optional(v.array(v.id("processPacks"))),
  },
  returns: vSaveResult,
  handler: async (ctx, args): Promise<typeof vSaveResult.type> =>
    await ctx.runMutation(internal.easygov.packs.data.save, args),
});

// --- Cases ------------------------------------------------------------------

/** The test user's cases, newest first. Guest cases aren't listed. */
export const cases = query({
  args: {},
  returns: v.array(
    v.object({
      id: v.id("cases"),
      startedAt: v.number(),
      status: v.string(),
      phase: vPhase,
      waitingFor: vWaitingFor,
      failed: v.boolean(),
      goal: v.optional(v.string()),
      source: v.optional(v.string()),
    }),
  ),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    const rows = await ctx.db
      .query("cases")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .order("desc")
      .take(30);
    return rows.map((row) => ({
      id: row._id,
      startedAt: row._creationTime,
      status: row.status,
      phase: phase(row),
      waitingFor: waitingFor(row),
      failed: row.run?.state === "failed",
      goal: row.goal?.text,
      source: row.source,
    }));
  },
});

/** A case's history, oldest first. */
export const history = query({
  args: { caseId: v.id("cases") },
  returns: v.array(
    v.object({
      at: v.number(),
      kind: vHistoryKind,
      detail: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, { caseId }) => {
    const rows = await ctx.db
      .query("caseEvents")
      .withIndex("by_caseId", (q) => q.eq("caseId", caseId))
      .take(300);
    return rows.map(({ _creationTime, kind, detail }) => ({
      at: _creationTime,
      kind,
      detail,
    }));
  },
});

// --- Firms ------------------------------------------------------------------

/** The firms the test user acts for. */
export const firms = query({
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
    const rows = await ctx.db
      .query("firms")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .take(50);
    return rows.map(({ _id, name, coverage }) => ({ id: _id, name, coverage }));
  },
});

/** `firms/data:save` for the test user: a new firm, or new coverage for one. */
export const saveFirm = mutation({
  args: {
    firmId: v.optional(v.id("firms")),
    name: v.string(),
    coverage: v.array(vCoverage),
  },
  returns: v.id("firms"),
  handler: async (ctx, args): Promise<Id<"firms">> =>
    await ctx.runMutation(internal.easygov.firms.data.save, {
      ...args,
      userId: await getAuthUserId(ctx),
    }),
});

/**
 * Every referral, newest first, with who took it and who passed: the whole
 * picture, to hold against what one firm is shown.
 */
export const referrals = query({
  args: {},
  returns: v.array(
    v.object({
      id: v.id("referrals"),
      caseId: v.id("cases"),
      kind: v.string(),
      status: v.string(),
      jurisdiction: v.optional(v.string()),
      priceCents: v.number(),
      source: v.optional(v.string()),
      firm: v.optional(v.string()),
      owed: v.boolean(),
    }),
  ),
  handler: async (ctx) => {
    const rows = await ctx.db.query("referrals").order("desc").take(50);
    const result = [];
    for (const row of rows) {
      const firmId = row.status === "accepted" ? row.firmId : null;
      const firm = firmId ? await ctx.db.get("firms", firmId) : null;
      const charges = firmId
        ? await ctx.db
            .query("referralCharges")
            .withIndex("by_firmId", (q) => q.eq("firmId", firmId))
            .take(200)
        : [];
      result.push({
        id: row._id,
        caseId: row.caseId,
        kind: row.kind,
        status: row.status,
        jurisdiction: row.jurisdiction,
        priceCents: row.priceCents,
        source: row.source,
        firm: firm?.name,
        owed: charges.some((charge) => charge.referralId === row._id),
      });
    }
    return result;
  },
});
