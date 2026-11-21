// The forms registry and its editions: what the test pages and the fill
// action read and write. The PDF work itself is in `actions.ts`.
import { addressKey, bareCode, isOfficialHost, sameFormCode } from "./sources";
import { requireOperator } from "../operators";
import { ConvexError, v, type Infer } from "convex/values";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type QueryCtx,
} from "../../_generated/server";
import { caller } from "../case/public";
import { fingerprintOf, pinnedPack } from "../case/state";
import { parseJurisdiction, vPackProfileLinks } from "../packs/schema";
import { isReading, READINGS } from "../profile/vocabulary";
import { mappingInputs, mappingQuestions } from "./mapping";
import {
  vAddressOutcome,
  vAttempt,
  vFormFacts,
  vMapping,
  vPageLink,
  vTarget,
  vVia,
} from "./schema";

/** Adds a form to the registry, or changes where one is fetched from. */
export const createForm = mutation({
  args: {
    code: v.string(),
    title: v.string(),
    jurisdiction: v.string(),
    sourceUrl: v.string(),
    /** Other places the same authority publishes the same file. */
    alternateUrls: v.optional(v.array(v.string())),
  },
  returns: v.id("forms"),
  handler: async (
    ctx,
    { code, title, jurisdiction, sourceUrl, alternateUrls },
  ) => {
    await requireOperator(ctx);
    const place = parseJurisdiction(jurisdiction);
    if (!place) throw new ConvexError('Use a jurisdiction path such as "us".');
    if (!code.trim() || !title.trim()) {
      throw new ConvexError("A form needs a code and a title.");
    }
    if (![sourceUrl, ...(alternateUrls ?? [])].every(isOfficialHost)) {
      throw new ConvexError(
        "A form is fetched from its authority's own https site (.gov).",
      );
    }
    const form = {
      code: code.trim(),
      title: title.trim(),
      jurisdiction: place,
      sourceUrl,
      alternateUrls: alternateUrls?.length ? alternateUrls : undefined,
    };
    const existing = await ctx.db
      .query("forms")
      .withIndex("by_code", (q) => q.eq("code", form.code))
      .first();
    if (!existing) return await ctx.db.insert("forms", form);
    await ctx.db.patch("forms", existing._id, form);
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
  /** How its bytes were got: a plain request, or a real browser. */
  via: v.optional(vVia),
  /** Its passwordless protection was removed, as the file allows. */
  opened: v.boolean(),
});

/** The registry, each form with its editions, newest first. */
export const listForms = query({
  args: {},
  returns: v.array(
    v.object({
      id: v.id("forms"),
      code: v.string(),
      title: v.string(),
      jurisdiction: v.string(),
      sourceUrl: v.string(),
      /** The last fetch, with every way and address tried. */
      lastFetch: v.optional(
        v.object({
          at: v.number(),
          ok: v.boolean(),
          attempts: v.array(vAttempt),
        }),
      ),
      /** Whether a hosted browser is set up to fall back on. */
      browser: v.boolean(),
      editions: v.array(vEditionSummary),
    }),
  ),
  handler: async (ctx) => {
    await requireOperator(ctx);
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
        lastFetch: form.lastFetch,
        browser: !!process.env.BROWSERBASE_API_KEY,
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
          via: e.obtained?.via,
          opened: e.opened ?? false,
        })),
      });
    }
    return rows;
  },
});

const vEdition = v.union(
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
);

/** One edition: its targets, its mapping, and a link to the blank PDF. */
async function editionOf(
  ctx: QueryCtx,
  editionId: Id<"formEditions">,
): Promise<Infer<typeof vEdition>> {
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
}

/** `editionOf`, for an operator's page. */
export const getEdition = query({
  args: { editionId: v.id("formEditions") },
  returns: vEdition,
  handler: async (ctx, { editionId }) => {
    await requireOperator(ctx);
    return await editionOf(ctx, editionId);
  },
});

/** `editionOf`, for a case's own work: no operator is signed in there. */
export const readEdition = internalQuery({
  args: { editionId: v.id("formEditions") },
  returns: vEdition,
  handler: async (ctx, { editionId }) => await editionOf(ctx, editionId),
});

/**
 * True once a pack fills the edition, in any version: cases pinned to it
 * fill the form from this mapping, so it can't go back to unreviewed.
 */
async function isPublished(
  ctx: QueryCtx,
  editionId: Id<"formEditions">,
): Promise<boolean> {
  const pack = await ctx.db
    .query("processPacks")
    .withIndex("by_form_editionId", (q) => q.eq("form.editionId", editionId))
    .first();
  return pack !== null;
}

/**
 * Saves a mapping for an edition. `reviewed` is a person saying they've
 * checked it against the form: only then is it used to fill a case. Once a
 * pack fills the edition, the mapping can be corrected but not unreviewed.
 */
export const updateMapping = mutation({
  args: {
    editionId: v.id("formEditions"),
    mapping: vMapping,
    reviewed: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, { editionId, mapping, reviewed }) => {
    await requireOperator(ctx);
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
    if (!reviewed && (await isPublished(ctx, editionId))) {
      throw new ConvexError(
        "A pack fills this edition, so its mapping stays reviewed.",
      );
    }
    await ctx.db.patch("formEditions", editionId, {
      mapping,
      mappingStatus: reviewed ? "reviewed" : "drafted",
    });
    return null;
  },
});

/** The filled PDF for a case, if it has one, as a link. */
export const getDocumentUrl = query({
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
    await requireOperator(ctx);
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
    const inputQuestions = mappingQuestions(
      found.mapping,
      Object.fromEntries(found.targets.map(({ id, kind }) => [id, kind])),
      (target) => labels.get(target) ?? target,
      (key) => (isReading(key) ? READINGS[key].label : undefined),
    );
    // Publishing the same thing twice is the pack that's already there.
    const same = (a: unknown, b: unknown) =>
      JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    if (
      previous?.form?.editionId === editionId &&
      same(previous.inputQuestions, inputQuestions) &&
      same(previous.profile, profile) &&
      previous.delivery === delivery
    ) {
      return previous._id;
    }
    const saved: { kind: string; id?: Id<"processPacks"> } =
      await ctx.runMutation(internal.easygov.packs.data.createPack, {
        title,
        description: `Fill in ${form.code}, ${form.title}, from the official form.`,
        aliases: [],
        jurisdiction: form.jurisdiction,
        forms: [form.code],
        inputs,
        // One question for each input: a profile reading by what it is, a
        // group of tick boxes as its choices.
        inputQuestions,
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
    v.object({
      urls: v.array(v.string()),
      code: v.string(),
      jurisdiction: v.string(),
    }),
    v.null(),
  ),
  handler: async (ctx, { formId }) => {
    const form = await ctx.db.get("forms", formId);
    return (
      form && {
        urls: [form.sourceUrl, ...(form.alternateUrls ?? [])],
        code: form.code,
        jurisdiction: form.jurisdiction,
      }
    );
  },
});

/** Keeps how the last fetch went: every way and address tried. */
export const recordAttempts = internalMutation({
  args: { formId: v.id("forms"), ok: v.boolean(), attempts: v.array(vAttempt) },
  returns: v.null(),
  handler: async (ctx, { formId, ok, attempts }) => {
    await ctx.db.patch("forms", formId, {
      lastFetch: { at: Date.now(), ok, attempts },
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
      // Read with the answers, so the filled form says which ones it holds.
      fingerprint: c ? fingerprintOf(c) : undefined,
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

// --- What official addresses answered ----------------------------------------

const vHeld = v.object({
  url: v.string(),
  checkedAt: v.number(),
  outcome: vAddressOutcome,
  note: v.optional(v.string()),
  failures: v.number(),
  packet: v.optional(v.string()),
  sha256: v.optional(v.string()),
  opening: v.optional(v.string()),
  facts: v.optional(vFormFacts),
  editionId: v.optional(v.id("formEditions")),
  etag: v.optional(v.string()),
  lastModified: v.optional(v.string()),
  links: v.optional(v.array(vPageLink)),
});

const addressRow = (ctx: QueryCtx, key: string) =>
  ctx.db
    .query("formAddresses")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();

/** How an address last answered, if it has been asked. */
export const addressOf = internalQuery({
  args: { key: v.string() },
  returns: v.union(vHeld, v.null()),
  handler: async (ctx, { key }) => {
    const row = await addressRow(ctx, key);
    if (!row) return null;
    const { _id, _creationTime, key: _key, chosen: _chosen, ...held } = row;
    return held;
  },
});

/** Keeps how an address answered, in place of how it answered before. */
export const recordAddress = internalMutation({
  args: {
    key: v.string(),
    ...vHeld.omit("checkedAt", "failures").fields,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await addressRow(ctx, args.key);
    const failed = args.outcome !== "file" && args.outcome !== "page";
    const answer = {
      ...args,
      checkedAt: Date.now(),
      failures: failed ? (row?.failures ?? 0) + 1 : 0,
      chosen: row?.chosen,
    };
    if (row) await ctx.db.replace("formAddresses", row._id, answer);
    else await ctx.db.insert("formAddresses", answer);
    return null;
  },
});

/**
 * Keeps a file as an edition, once, and says what is known of it. The same
 * bytes are one file whichever address served them, and two addresses can
 * serve them at the same moment: so looking and keeping are one step. With
 * no `fresh`, it only looks.
 */
export const keepFile = internalMutation({
  args: {
    sha256: v.string(),
    fresh: v.optional(
      v.object({
        /** The registry entry it belongs to, or the source to make one for. */
        formId: v.optional(v.id("forms")),
        sourceUrl: v.string(),
        code: v.string(),
        jurisdiction: v.string(),
        edition: v.object({
          storageId: v.id("_storage"),
          edition: v.optional(v.string()),
          pages: v.number(),
          fillable: v.boolean(),
          targets: v.array(vTarget),
          obtained: v.object({ via: vVia, url: v.string() }),
          opened: v.boolean(),
        }),
      }),
    ),
  },
  returns: v.object({
    editionId: v.optional(v.id("formEditions")),
    /** True if this call kept it: otherwise the caller's copy isn't needed. */
    kept: v.boolean(),
    opening: v.optional(v.string()),
    facts: v.optional(vFormFacts),
  }),
  handler: async (ctx, { sha256, fresh }) => {
    const existing = await ctx.db
      .query("formEditions")
      .withIndex("by_sha256", (q) => q.eq("sha256", sha256))
      .first();
    const read = await ctx.db
      .query("formAddresses")
      .withIndex("by_sha256", (q) => q.eq("sha256", sha256))
      .first();
    const known = { opening: read?.opening, facts: read?.facts };
    if (existing || !fresh) {
      return { editionId: existing?._id, kept: false, ...known };
    }
    const { formId, edition, sourceUrl, code, jurisdiction } = fresh;
    const form =
      formId ??
      (
        await ctx.db
          .query("forms")
          .withIndex("by_sourceUrl", (q) => q.eq("sourceUrl", sourceUrl))
          .first()
      )?._id ??
      (await ctx.db.insert("forms", {
        sourceUrl,
        code,
        jurisdiction,
        title: code,
      }));
    const editionId = await ctx.db.insert("formEditions", {
      formId: form,
      sha256,
      checkedAt: Date.now(),
      mapping: [],
      mappingStatus: "none",
      currency: { status: "unconfirmed" },
      ...edition,
    });
    return { editionId, kept: true, ...known };
  },
});

/** As many files as are remembered for one form. */
const MAX_REMEMBERED = 3;

/** The addresses chosen for a form, latest first. */
async function chosenFor(ctx: QueryCtx, jurisdiction: string, code: string) {
  const rows = await ctx.db
    .query("formAddresses")
    .withIndex("by_chosen", (q) =>
      q
        .eq("chosen.jurisdiction", jurisdiction)
        .eq("chosen.bare", bareCode(code)),
    )
    .take(50);
  return rows
    .filter((row) => sameFormCode(row.chosen!.code, code))
    .sort(
      (a, b) =>
        b.chosen!.at - a.chosen!.at || b._creationTime - a._creationTime,
    );
}

/**
 * The addresses earlier cases chose for a form, latest first. A form is a
 * fact about the world, not about a case: the next case starts from its file
 * and doesn't depend on a search finding it again.
 */
export const knownSources = internalQuery({
  args: { jurisdiction: v.string(), code: v.string() },
  returns: v.array(v.string()),
  handler: async (ctx, { jurisdiction, code }) =>
    (await chosenFor(ctx, jurisdiction, code)).map((row) => row.url),
});

/**
 * Remembers the address chosen for a form. What that makes redundant is
 * forgotten: another address of the same file, an earlier revision, and all
 * but the few latest. A different file of the same revision stays, so one
 * poor choice can't push out a good one.
 */
export const rememberChosen = internalMutation({
  args: { jurisdiction: v.string(), code: v.string(), url: v.string() },
  returns: v.null(),
  handler: async (ctx, { jurisdiction, code, url }) => {
    const row = await addressRow(ctx, addressKey(url));
    if (!row) return null;
    const others = (await chosenFor(ctx, jurisdiction, code)).filter(
      (other) => other._id !== row._id,
    );
    const revision = row.facts?.revision;
    const redundant = (other: (typeof others)[number]) =>
      other.sha256 === row.sha256 ||
      (revision !== undefined &&
        (other.facts?.revision ?? revision) < revision);
    const kept = others.filter((other) => !redundant(other));
    for (const other of others) {
      if (kept.indexOf(other) >= MAX_REMEMBERED - 1 || redundant(other)) {
        await ctx.db.patch("formAddresses", other._id, { chosen: undefined });
      }
    }
    await ctx.db.patch("formAddresses", row._id, {
      chosen: { jurisdiction, bare: bareCode(code), code, at: Date.now() },
    });
    return null;
  },
});

/** As many hosted browsers as all cases have open at once: the service allows 24. */
export const MAX_BROWSERS = 20;

/** Longer than any browser job: a lease left by work that died ends itself. */
export const BROWSER_LEASE_MS = 5 * 60_000;

/** Takes a place for one browser, if one is free. */
export const takeBrowserLease = internalMutation({
  args: {},
  returns: v.union(v.id("browserLeases"), v.null()),
  handler: async (ctx) => {
    const now = Date.now();
    const leases = await ctx.db
      .query("browserLeases")
      .withIndex("by_expiresAt")
      .take(MAX_BROWSERS * 3);
    const live = leases.filter((lease) => lease.expiresAt > now);
    for (const lease of leases) {
      if (lease.expiresAt <= now)
        await ctx.db.delete("browserLeases", lease._id);
    }
    if (live.length >= MAX_BROWSERS) return null;
    return await ctx.db.insert("browserLeases", {
      expiresAt: now + BROWSER_LEASE_MS,
    });
  },
});

export const releaseBrowserLease = internalMutation({
  args: { leaseId: v.id("browserLeases") },
  returns: v.null(),
  handler: async (ctx, { leaseId }) => {
    if (await ctx.db.get("browserLeases", leaseId)) {
      await ctx.db.delete("browserLeases", leaseId);
    }
    return null;
  },
});

export const saveBlueprint = internalMutation({
  args: {
    editionId: v.id("formEditions"),
    targets: v.array(vTarget),
    mapping: vMapping,
  },
  returns: v.id("formBlueprints"),
  handler: async (ctx, args) => ctx.db.insert("formBlueprints", args),
});

export const blueprintForFill = internalQuery({
  args: { id: v.id("formBlueprints") },
  returns: v.object({
    storageId: v.id("_storage"),
    targets: v.array(vTarget),
    mapping: vMapping,
  }),
  handler: async (ctx, { id }) => {
    const blueprint = await ctx.db.get("formBlueprints", id);
    const edition =
      blueprint && (await ctx.db.get("formEditions", blueprint.editionId));
    if (!blueprint || !edition) throw new Error("Form edition is unavailable.");
    return {
      storageId: edition.storageId,
      targets: blueprint.targets,
      mapping: blueprint.mapping,
    };
  },
});

export const latestBlueprint = internalQuery({
  args: { editionId: v.id("formEditions") },
  returns: v.union(
    v.null(),
    v.object({
      id: v.id("formBlueprints"),
      mapping: vMapping,
      targets: v.array(vTarget),
    }),
  ),
  handler: async (ctx, { editionId }) => {
    const found = await ctx.db
      .query("formBlueprints")
      .withIndex("by_editionId", (q) => q.eq("editionId", editionId))
      .order("desc")
      .first();
    return found
      ? { id: found._id, mapping: found.mapping, targets: found.targets }
      : null;
  },
});

export { isOfficialHost };
