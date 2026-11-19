// The pack library: finding packs a case may use, and saving new ones.
//
// A pack has no key. Labels a model writes drift between runs ("courts" vs
// "state-court"), so a pack is found by search within its jurisdiction and
// the ones containing it, and a model compares the candidates.
import { ConvexError, type Infer, v } from "convex/values";
import type { Doc, Id } from "../../_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type QueryCtx,
} from "../../_generated/server";
import { placeholders } from "../case/answers";
import {
  jurisdictionChain,
  normalizeFormId,
  packDefinition,
  parseJurisdiction,
  vProcessPackDefinition,
  vPackMatch,
} from "./schema";

type PackMatch = Infer<typeof vPackMatch>;
type Definition = Infer<typeof vProcessPackDefinition>;

/** At most this many candidates, so a person can review all of them. */
const MAX_CANDIDATES = 5;

function searchWords(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

// Search matches any word, so filler words would match every pack.
const FILLER = new Set(
  (
    "a an and are as at be by can do does for from get got have help how i in " +
    "is it me my need of on or our that the this to what with you your"
  ).split(" "),
);

function match(pack: Doc<"processPacks">): PackMatch {
  const { _id, title, description, jurisdiction, authority, forms } = pack;
  return { id: _id, title, description, jurisdiction, authority, forms };
}

/**
 * Current packs in `places` that may fit. Shared packs and the owner's own
 * are both searched, narrowest place first. `skip` are packs already
 * reviewed; the search reads past them so they can't hide new ones.
 */
async function candidates(
  ctx: QueryCtx,
  places: string[],
  ownerId: string | undefined,
  text: string,
  skip: Id<"processPacks">[] = [],
): Promise<PackMatch[]> {
  const words = searchWords(text)
    .filter((word) => !FILLER.has(word))
    .map((word) => word.slice(0, 32));
  const query = [...new Set(words)].slice(0, 16).join(" ");
  if (!query) return [];
  const owners = [...new Set([ownerId, undefined])];
  const searches = places.flatMap((place) =>
    owners.map((owner) =>
      ctx.db
        .query("processPacks")
        .withSearchIndex("search_packs", (q) =>
          q
            .search("searchText", query)
            .eq("ownerId", owner)
            .eq("jurisdiction", place)
            .eq("status", "current"),
        )
        .take(MAX_CANDIDATES + skip.length),
    ),
  );
  const found = (await Promise.all(searches)).flat();
  return found
    .filter((pack) => !skip.includes(pack._id))
    .slice(0, MAX_CANDIDATES)
    .map(match);
}

/** Normalizes a definition, or says what's wrong with it. */
function checkDefinition(raw: Definition): Definition {
  const jurisdiction = parseJurisdiction(raw.jurisdiction);
  if (!jurisdiction) {
    throw new ConvexError(
      'Use a jurisdiction path such as "us", "us/ca" or "us/ca/alameda".',
    );
  }
  if (!raw.title.trim() || !raw.description.trim()) {
    throw new ConvexError("The title and description are required.");
  }
  const forms = [...new Set(raw.forms.map(normalizeFormId))];
  if (forms.some((form) => !form) || forms.length > 10) {
    throw new ConvexError("List up to 10 official form numbers.");
  }
  const { inputs, inputQuestions, referral } = raw;
  if (
    new Set(inputs).size !== inputs.length ||
    inputs.some((key) => !key.trim() || Object.hasOwn(Object.prototype, key))
  ) {
    throw new ConvexError("Input keys must be nonempty and unique.");
  }
  if (
    inputQuestions &&
    (inputQuestions.length !== inputs.length ||
      inputQuestions.some(
        ({ key, question }, i) => key !== inputs[i] || !question.trim(),
      ))
  ) {
    throw new ConvexError(
      "Provide a question for each input, in the same order.",
    );
  }
  if (referral && !referral.kind.trim()) {
    throw new ConvexError("Name the kind of referral.");
  }
  const price = referral?.priceCents;
  if (price !== undefined && (!Number.isInteger(price) || price < 0)) {
    throw new ConvexError("The referral's price is a whole number of cents.");
  }
  if (referral?.when && !inputs.includes(referral.when.input)) {
    throw new ConvexError(
      `The referral depends on "${referral.when.input}", which isn't an input.`,
    );
  }
  const { documents = [], deadline, output } = raw;
  const documentKeys = documents.map(({ key }) => key);
  if (
    documents.length > 20 ||
    new Set(documentKeys).size !== documentKeys.length ||
    documents.some(({ key, label }) => !key.trim() || !label.trim())
  ) {
    throw new ConvexError(
      "List up to 20 documents, each with a label and its own key.",
    );
  }
  if (deadline) {
    const { label, fromInput, days } = deadline;
    if (!inputs.includes(fromInput)) {
      throw new ConvexError(
        `The deadline counts from "${fromInput}", which isn't an input.`,
      );
    }
    if (!label.trim() || !Number.isInteger(days) || days < 1 || days > 3650) {
      throw new ConvexError(
        "A deadline needs a label and a whole number of days.",
      );
    }
  }
  const unknown = placeholders(output?.letter ?? "").find(
    (key) => !inputs.includes(key),
  );
  if (unknown) {
    throw new ConvexError(
      `The letter uses "${unknown}", which isn't an input.`,
    );
  }
  const authority = raw.authority?.trim() || undefined;
  return { ...raw, jurisdiction, authority, forms };
}

function searchTextOf(definition: Definition): string {
  const { title, description, aliases, authority, forms } = definition;
  const text = [title, description, ...aliases, authority ?? "", ...forms];
  return searchWords(text.join(" ")).join(" ");
}

/** How many versions `currentVersion` follows before giving up. */
const MAX_VERSIONS = 50;

/**
 * The current version of a shared pack, following the versions that replaced
 * it, so an old link still starts the process as it is now. Null if the pack
 * is missing or isn't shared.
 */
export async function currentVersion(
  ctx: QueryCtx,
  id: Id<"processPacks">,
): Promise<Doc<"processPacks"> | null> {
  let pack = await ctx.db.get("processPacks", id);
  for (let i = 0; pack && pack.status !== "current" && i < MAX_VERSIONS; i++) {
    pack = await ctx.db
      .query("processPacks")
      .withIndex("by_supersedes", (q) => q.eq("supersedes", pack!._id))
      .first();
  }
  return pack?.status === "current" && pack.ownerId === undefined ? pack : null;
}

/** Packs that may fit a case's request, for the selection model to compare. */
export const findMatch = internalQuery({
  args: {
    caseId: v.id("cases"),
    jurisdiction: v.string(),
    terms: v.string(),
  },
  returns: v.array(vPackMatch),
  handler: async (
    ctx,
    { caseId, jurisdiction, terms },
  ): Promise<PackMatch[]> => {
    const found = await ctx.db.get("cases", caseId);
    const place = parseJurisdiction(jurisdiction);
    if (!found || !place) return [];
    // A county request also finds state and federal packs.
    const places = jurisdictionChain(place);
    return await candidates(ctx, places, found.userId, terms.slice(0, 512));
  },
});

const vSaveResult = v.union(
  v.object({ kind: v.literal("created"), id: v.id("processPacks") }),
  v.object({ kind: v.literal("reviewDuplicates"), packs: v.array(vPackMatch) }),
);

/**
 * Saves a reviewed pack. A saved row never changes, so the cases that pinned
 * it keep running it. Without an `ownerId` the pack is shared: every case can
 * find it. That's how packs are seeded, e.g.
 * `npx convex run easygov/packs/data:save '{...}'`.
 *
 * With `supersedes`, the pack is the next version of that one, which stops
 * being found. Otherwise, similar packs come back for review first; list them
 * in `reviewedPackIds` to save anyway.
 */
export const save = internalMutation({
  args: {
    ownerId: v.optional(v.string()),
    ...packDefinition,
    supersedes: v.optional(v.id("processPacks")),
    reviewedPackIds: v.optional(v.array(v.id("processPacks"))),
  },
  returns: vSaveResult,
  handler: async (
    ctx,
    { ownerId, supersedes, reviewedPackIds = [], ...raw },
  ): Promise<Infer<typeof vSaveResult>> => {
    if (ownerId?.trim() === "") throw new ConvexError("The owner is empty.");
    if (reviewedPackIds.length > 64) {
      throw new ConvexError(
        "Too many possible matches. Refine the pack's title and aliases.",
      );
    }
    const definition = checkDefinition(raw);
    const previous =
      supersedes && (await ctx.db.get("processPacks", supersedes));
    if (supersedes) {
      if (!previous || previous.ownerId !== ownerId) {
        throw new ConvexError(
          "Only the pack's owner can publish a new version.",
        );
      }
      if (previous.status !== "current") {
        throw new ConvexError("That version has already been replaced.");
      }
    }

    const skip = previous
      ? [...reviewedPackIds, previous._id]
      : reviewedPackIds;
    const text = [
      definition.title,
      ...definition.aliases,
      definition.description,
      definition.authority ?? "",
      ...definition.forms,
    ].join(" ");
    // Packs for another jurisdiction are other processes, not duplicates.
    const duplicates = await candidates(
      ctx,
      [definition.jurisdiction],
      ownerId,
      text,
      skip,
    );
    if (duplicates.length)
      return { kind: "reviewDuplicates", packs: duplicates };

    const id = await ctx.db.insert("processPacks", {
      ...definition,
      ownerId,
      status: "current",
      supersedes: previous ? previous._id : undefined,
      searchText: searchTextOf(definition),
    });
    if (previous)
      await ctx.db.patch("processPacks", previous._id, {
        status: "superseded",
      });
    return { kind: "created", id };
  },
});
