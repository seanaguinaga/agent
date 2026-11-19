// The forms registry and its editions: what the test pages and the fill
// action read and write. The PDF work itself is in `actions.ts`.
import { ConvexError, v } from "convex/values";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "../../_generated/server";
import { caller } from "../case/public";
import { pinnedPack } from "../case/state";
import { parseJurisdiction, vPackProfileLinks } from "../packs/schema";
import { isReading, READINGS } from "../profile/vocabulary";
import { mappingInputs, mappingQuestions } from "./mapping";
import { vMapping, vTarget } from "./schema";

/** Hosts a form may be fetched from: the authority's own. */
export function isOfficialHost(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return (
      protocol === "https:" &&
      /(?:^|\.)(?:gov|mil)$|\.(?:gov|us)$|(?:^|\.)ca\.gov$/.test(hostname)
    );
  } catch {
    return false;
  }
}

/** Adds a form to the registry, or changes where one is fetched from. */
export const register = mutation({
  args: {
    code: v.string(),
    title: v.string(),
    jurisdiction: v.string(),
    sourceUrl: v.string(),
  },
  returns: v.id("forms"),
  handler: async (ctx, { code, title, jurisdiction, sourceUrl }) => {
    const place = parseJurisdiction(jurisdiction);
    if (!place) throw new ConvexError('Use a jurisdiction path such as "us".');
    if (!code.trim() || !title.trim()) {
      throw new ConvexError("A form needs a code and a title.");
    }
    if (!isOfficialHost(sourceUrl)) {
      throw new ConvexError(
        "A form is fetched from its authority's own https site (.gov).",
      );
    }
    const form = {
      code: code.trim(),
      title: title.trim(),
      jurisdiction: place,
      sourceUrl,
    };
    const existing = await ctx.db
      .query("forms")
      .withIndex("by_code", (q) => q.eq("code", form.code))
      .first();
    if (!existing) return await ctx.db.insert("forms", form);
    await ctx.db.replace("forms", existing._id, form);
    return existing._id;
  },
});

const vEditionSummary = v.object({
  id: v.id("formEditions"),
  sha256: v.string(),
  fetchedAt: v.number(),
  checkedAt: v.number(),
  edition: v.optional(v.string()),
  pages: v.number(),
  fillable: v.boolean(),
  targets: v.number(),
  mapped: v.number(),
  mappingStatus: v.string(),
  currency: v.string(),
});

/** The registry, each form with its editions, newest first. */
export const list = query({
  args: {},
  returns: v.array(
    v.object({
      id: v.id("forms"),
      code: v.string(),
      title: v.string(),
      jurisdiction: v.string(),
      sourceUrl: v.string(),
      editions: v.array(vEditionSummary),
    }),
  ),
  handler: async (ctx) => {
    const forms = await ctx.db.query("forms").order("desc").take(50);
    const rows = [];
    for (const form of forms) {
      const editions = await ctx.db
        .query("formEditions")
        .withIndex("by_formId", (q) => q.eq("formId", form._id))
        .order("desc")
        .take(10);
      rows.push({
        id: form._id,
        code: form.code,
        title: form.title,
        jurisdiction: form.jurisdiction,
        sourceUrl: form.sourceUrl,
        editions: editions.map((e) => ({
          id: e._id,
          sha256: e.sha256,
          fetchedAt: e._creationTime,
          checkedAt: e.checkedAt,
          edition: e.edition,
          pages: e.pages,
          fillable: e.fillable,
          targets: e.targets.length,
          mapped: e.mapping.length,
          mappingStatus: e.mappingStatus,
          currency: e.currency.status,
        })),
      });
    }
    return rows;
  },
});

/** One edition: its targets, its mapping, and a link to the blank PDF. */
export const edition = query({
  args: { editionId: v.id("formEditions") },
  returns: v.union(
    v.object({
      id: v.id("formEditions"),
      code: v.string(),
      title: v.string(),
      edition: v.optional(v.string()),
      fillable: v.boolean(),
      targets: v.array(vTarget),
      mapping: vMapping,
      mappingStatus: v.string(),
      /** The input keys the mapping reads: what a pack on this form asks. */
      inputs: v.array(v.string()),
      url: v.union(v.string(), v.null()),
    }),
    v.null(),
  ),
  handler: async (ctx, { editionId }) => {
    const found = await ctx.db.get("formEditions", editionId);
    const form = found && (await ctx.db.get("forms", found.formId));
    if (!found || !form) return null;
    return {
      id: found._id,
      code: form.code,
      title: form.title,
      edition: found.edition,
      fillable: found.fillable,
      targets: found.targets,
      mapping: found.mapping,
      mappingStatus: found.mappingStatus,
      inputs: mappingInputs(found.mapping),
      url: await ctx.storage.getUrl(found.storageId),
    };
  },
});

/**
 * Saves a mapping for an edition. `reviewed` is a person saying they've
 * checked it against the form: only then is it used to fill a case.
 */
export const saveMapping = mutation({
  args: {
    editionId: v.id("formEditions"),
    mapping: vMapping,
    reviewed: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, { editionId, mapping, reviewed }) => {
    const found = await ctx.db.get("formEditions", editionId);
    if (!found) throw new ConvexError("Edition not found.");
    const kinds = new Map(found.targets.map(({ id, kind }) => [id, kind]));
    const seen = new Set<string>();
    for (const entry of mapping) {
      if (!kinds.has(entry.target)) {
        throw new ConvexError(`"${entry.target}" isn't a target of this form.`);
      }
      if (seen.has(entry.target)) {
        throw new ConvexError(`"${entry.target}" is mapped twice.`);
      }
      seen.add(entry.target);
      const said = [entry.input, entry.constant, entry.leave].filter(
        (part) => part !== undefined,
      );
      if (said.length !== 1) {
        throw new ConvexError(
          `"${entry.target}" needs exactly one of an input, a constant, or a reason it's left for the person.`,
        );
      }
      const ticks = [entry.equals, entry.includes].filter(
        (part) => part !== undefined,
      ).length;
      const box = kinds.get(entry.target) === "check";
      if (entry.input && box ? ticks !== 1 : ticks !== 0) {
        throw new ConvexError(
          box
            ? `The tick box "${entry.target}" needs one of "equals" or "includes".`
            : `"${entry.target}" isn't a tick box: it takes no "equals" or "includes".`,
        );
      }
    }
    // Boxes sharing an input are one question: all pick-one, or all
    // check-all-that-apply.
    for (const key of mappingInputs(mapping)) {
      const boxes = mapping.filter(
        (entry) => entry.input === key && kinds.get(entry.target) === "check",
      );
      if (
        boxes.some((entry) => entry.includes !== undefined) &&
        boxes.some((entry) => entry.equals !== undefined)
      ) {
        throw new ConvexError(
          `The boxes for "${key}" mix "equals" and "includes".`,
        );
      }
    }
    await ctx.db.patch("formEditions", editionId, {
      mapping,
      mappingStatus: reviewed ? "reviewed" : "drafted",
    });
    return null;
  },
});

/** The filled PDF for a case, if it has one, as a link. */
export const documentUrl = query({
  args: { caseId: v.id("cases"), guestKey: v.optional(v.string()) },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { caseId, guestKey }) => {
    const userId = await caller(ctx, guestKey);
    const found = await ctx.db.get("cases", caseId);
    if (!found || found.userId !== userId)
      throw new ConvexError("Case not found.");
    const storageId = found.artifact?.document?.storageId;
    return storageId ? await ctx.storage.getUrl(storageId) : null;
  },
});

/**
 * Publishes a shared pack that fills this edition: its inputs are what the
 * reviewed mapping reads. A pack already published for the form is replaced
 * by a new version, so cases under way keep the edition they started on.
 */
export const publishPack = mutation({
  args: {
    editionId: v.id("formEditions"),
    /** How its case inputs meet the profile: see `profile` on a pack. */
    profile: v.optional(vPackProfileLinks),
    delivery: v.optional(v.union(v.literal("mail"), v.literal("online"))),
  },
  returns: v.id("processPacks"),
  handler: async (
    ctx,
    { editionId, profile, delivery },
  ): Promise<Id<"processPacks">> => {
    const found = await ctx.db.get("formEditions", editionId);
    const form = found && (await ctx.db.get("forms", found.formId));
    if (!found || !form) throw new ConvexError("Edition not found.");
    if (found.mappingStatus !== "reviewed") {
      throw new ConvexError("Review the mapping before publishing a pack.");
    }
    const inputs = mappingInputs(found.mapping);
    const labels = new Map(found.targets.map(({ id, label }) => [id, label]));
    const title = `${form.title} (${form.code})`;
    const shared = await ctx.db
      .query("processPacks")
      .withIndex("by_ownerId_and_status", (q) =>
        q.eq("ownerId", undefined).eq("status", "current"),
      )
      .take(200);
    const previous = shared.find((pack) => pack.title === title);
    const saved: { kind: string; id?: Id<"processPacks"> } =
      await ctx.runMutation(internal.easygov.packs.data.save, {
        title,
        description: `Fill in ${form.code}, ${form.title}, from the official form.`,
        aliases: [],
        jurisdiction: form.jurisdiction,
        forms: [form.code],
        inputs,
        // One question for each input: a profile reading by what it is, a
        // group of tick boxes as its choices.
        inputQuestions: mappingQuestions(
          found.mapping,
          Object.fromEntries(found.targets.map(({ id, kind }) => [id, kind])),
          (target) => labels.get(target) ?? target,
          (key) => (isReading(key) ? READINGS[key].label : undefined),
        ),
        form: { editionId },
        profile,
        delivery,
        supersedes: previous?._id,
        // Other packs for the same form are the ones being replaced.
        reviewedPackIds: shared.map((pack) => pack._id),
      });
    if (!saved.id) throw new ConvexError("The pack couldn't be saved.");
    return saved.id;
  },
});

// --- For the actions --------------------------------------------------------

export const formOf = internalQuery({
  args: { formId: v.id("forms") },
  returns: v.union(
    v.object({ sourceUrl: v.string(), code: v.string() }),
    v.null(),
  ),
  handler: async (ctx, { formId }) => {
    const form = await ctx.db.get("forms", formId);
    return form && { sourceUrl: form.sourceUrl, code: form.code };
  },
});

/** Records a fetch: the same bytes again, or a new edition. */
export const recordFetch = internalMutation({
  args: {
    formId: v.id("forms"),
    sha256: v.string(),
    /** Set when these bytes are new: what was read from them. */
    fresh: v.optional(
      v.object({
        storageId: v.id("_storage"),
        edition: v.optional(v.string()),
        pages: v.number(),
        fillable: v.boolean(),
        targets: v.array(vTarget),
      }),
    ),
  },
  returns: v.union(v.id("formEditions"), v.null()),
  handler: async (ctx, { formId, sha256, fresh }) => {
    const existing = await ctx.db
      .query("formEditions")
      .withIndex("by_formId_and_sha256", (q) =>
        q.eq("formId", formId).eq("sha256", sha256),
      )
      .first();
    if (existing) {
      await ctx.db.patch("formEditions", existing._id, {
        checkedAt: Date.now(),
      });
      return existing._id;
    }
    if (!fresh) return null;
    return await ctx.db.insert("formEditions", {
      formId,
      sha256,
      checkedAt: Date.now(),
      mapping: [],
      mappingStatus: "none",
      currency: { status: "unconfirmed" },
      ...fresh,
    });
  },
});

/**
 * Replaces an edition's targets, after the reading of the page improved. A
 * mapping made against the old ones can't be trusted, so it's dropped.
 */
export const replaceTargets = internalMutation({
  args: { editionId: v.id("formEditions"), targets: v.array(vTarget) },
  returns: v.null(),
  handler: async (ctx, { editionId, targets }) => {
    await ctx.db.patch("formEditions", editionId, {
      targets,
      mapping: [],
      mappingStatus: "none",
    });
    return null;
  },
});

/** What filling needs: the blank form, its targets and reviewed mapping. */
export const fillInput = internalQuery({
  args: {
    editionId: v.id("formEditions"),
    caseId: v.optional(v.id("cases")),
  },
  returns: v.object({
    storageId: v.id("_storage"),
    targets: v.array(vTarget),
    mapping: vMapping,
    reviewed: v.boolean(),
    answers: v.record(v.string(), v.string()),
    fingerprint: v.optional(v.string()),
  }),
  handler: async (ctx, { editionId, caseId }) => {
    const found = await ctx.db.get("formEditions", editionId);
    if (!found) throw new Error("Edition not found");
    const c = caseId ? await ctx.db.get("cases", caseId) : null;
    return {
      storageId: found.storageId,
      targets: found.targets,
      mapping: found.mapping,
      reviewed: found.mappingStatus === "reviewed",
      answers: c?.answers ?? {},
      fingerprint: undefined,
    };
  },
});

/** The edition a case's pack fills, if it fills one. */
export const editionOfCase = internalQuery({
  args: { caseId: v.id("cases") },
  returns: v.union(v.id("formEditions"), v.null()),
  handler: async (ctx, { caseId }) => {
    const found = await ctx.db.get("cases", caseId);
    return (found && pinnedPack(found)?.form?.editionId) ?? null;
  },
});
