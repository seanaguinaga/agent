import { defineTable } from "convex/server";
import { v, type Infer } from "convex/values";

export const vProcessPackQuestions = v.array(
  v.object({
    key: v.string(),
    question: v.string(),
    /**
     * The answers to pick from, when the question is a set of tick boxes.
     * The answer is a choice's `value`; with `multiple`, the values of all
     * that apply, joined by commas.
     */
    choices: v.optional(
      v.array(v.object({ value: v.string(), label: v.string() })),
    ),
    multiple: v.optional(v.boolean()),
  }),
);
export const vLetterRoute = v.object({
  key: v.string(),
  equals: v.string(),
  inputs: v.array(v.string()),
});
const vProcessPackOutput = v.object({
  filingOrder: v.optional(v.array(v.string())),
  title: v.string(),
  checklist: v.array(v.string()),
  /**
   * A letter to write from the answers, e.g. a complaint or a demand letter.
   * `{{fullName}}` is replaced by the answer to `fullName`.
   */
  letter: v.optional(v.string()),
  /** The official pages a drafted checklist was written from. */
  sources: v.optional(v.array(v.string())),
  /**
   * Inputs about the person's own situation ("online or by mail?") that
   * decide which checklist steps apply to them. Once they're answered, the
   * steps that don't apply are left out of the person's document.
   */
  tailorBy: v.optional(v.array(v.string())),
});

/** A file the person attaches, e.g. the denial letter they received. */
export const vRouteCondition = v.object({
  key: v.string(),
  equals: v.string(),
});
export const vPackEvidence = v.array(
  v.object({
    key: v.string(),
    label: v.string(),
    required: v.boolean(),
    when: v.optional(vRouteCondition),
  }),
);

/**
 * A date the person must act by: `days` after the date they answered
 * `fromInput` with, e.g. 60 days after `denialDate`.
 */
export const vPackDeadline = v.object({
  label: v.string(),
  fromInput: v.string(),
  days: v.number(),
});

/**
 * A check on one answer. `atLeast` reads the answer as a number;
 * `withinDays` reads it as a date (YYYY-MM-DD) and passes while that date is
 * today or at most that many days ago.
 */
export const vSignal = v.union(
  v.object({ input: v.string(), equals: v.string() }),
  v.object({ input: v.string(), atLeast: v.number() }),
  v.object({ input: v.string(), withinDays: v.number() }),
);
export type Signal = Infer<typeof vSignal>;

/**
 * A legal referral to offer once the person accepts, e.g. representation
 * for an appeal. With `when` or `orWhen`, only if one of those answers passes. The person is
 * asked first: nothing is shared unless they say so. The price is fixed: it
 * doesn't depend on what comes of the case.
 */
export const vPackReferral = v.object({
  kind: v.string(),
  when: v.optional(vSignal),
  /**
   * Other answers that make the case one a lawyer takes: any one passing
   * is enough, as `when` passing is. A case is rarely worth a lawyer for one
   * reason only: the amount, how close the deadline is, how far it has gone.
   */
  orWhen: v.optional(v.array(vSignal)),
  /** What the firm that accepts it pays, if not the usual price. */
  priceCents: v.optional(v.number()),
});

export const vPackProfileLinks = v.array(
  v.object({
    input: v.string(),
    reads: v.optional(v.string()),
    updates: v.optional(v.string()),
  }),
);

/**
 * What a pack is. There is no key: a pack is its row. Every label here comes
 * from a person or a model and varies ("courts" vs "state-court"), so labels
 * only feed search, and a model compares the candidates.
 */
export const vPacketForm = v.object({
  code: v.string(),
  sourceUrl: v.string(),
  when: v.optional(vRouteCondition),
  blueprintId: v.optional(v.id("formBlueprints")),
  inputs: v.array(v.string()),
  openItem: v.optional(v.string()),
});
export const vEligibility = v.array(
  v.object({
    condition: v.string(),
    sourceUrl: v.string(),
    key: v.string(),
    qualifiesWhen: v.string(),
  }),
);
export const packDefinition = {
  letterRoute: v.optional(vLetterRoute),
  packetForms: v.optional(v.array(vPacketForm)),
  eligibility: v.optional(vEligibility),
  title: v.string(),
  description: v.string(),
  aliases: v.array(v.string()),
  /** Where it applies, as a path: "us", "us/ca", "us/ca/alameda". */
  jurisdiction: v.string(),
  /** Who handles it, as people name it. Searched, never filtered on. */
  authority: v.optional(v.string()),
  /** Official form numbers, e.g. "IRS-8822". Searched, never filtered on. */
  forms: v.array(v.string()),
  inputs: v.array(v.string()),
  /** Files to attach along with the answers. */
  evidence: v.optional(vPackEvidence),
  deadline: v.optional(vPackDeadline),
  referral: v.optional(vPackReferral),
  /**
   * How inputs that aren't profile readings still meet the profile. `reads`
   * offers a reading as the input's starting answer ("your old address" is
   * today's home address). `updates` names the fact the answer becomes once
   * the case is done ("your new address" becomes the home address), which
   * the person is then asked to accept.
   */
  profile: v.optional(vPackProfileLinks),
  /**
   * The official form this pack fills: one fetched edition, with its
   * reviewed mapping. The pack's inputs are what that mapping reads.
   */
  form: v.optional(v.object({ editionId: v.id("formEditions") })),
  /** How the accepted document goes out. Without one, the case just ends. */
  delivery: v.optional(v.union(v.literal("mail"), v.literal("online"))),
  inputQuestions: v.optional(vProcessPackQuestions),
  output: v.optional(vProcessPackOutput),
};
export const vProcessPackDefinition = v.object(packDefinition);

export const processPacks = defineTable({
  ...packDefinition,
  /** Absent for a shared pack, which every case can find. */
  ownerId: v.optional(v.string()),
  /** Only current packs are found. Cases keep the version they pinned. */
  status: v.union(v.literal("current"), v.literal("superseded")),
  /** The version this one replaced. */
  supersedes: v.optional(v.id("processPacks")),
  /** Derived from the definition because each search index takes one text field. */
  searchText: v.string(),
})
  // Shared current packs, for landing pages.
  .index("by_ownerId_and_status", ["ownerId", "status"])
  // The version that replaced a pack, to follow an old link to the new one.
  .index("by_supersedes", ["supersedes"])
  // The packs that fill an edition: its mapping can't be taken back.
  .index("by_form_editionId", ["form.editionId"])
  .searchIndex("search_packs", {
    searchField: "searchText",
    filterFields: ["ownerId", "jurisdiction", "status"],
  });

export const vPackMatch = v.object({
  id: v.id("processPacks"),
  title: v.string(),
  description: v.string(),
  jurisdiction: v.string(),
  authority: v.optional(v.string()),
  forms: v.array(v.string()),
});

/** What an input key looks like: `fullName`, `lastWorkDate`. */
export const INPUT_KEY = /^[a-z][a-zA-Z0-9]{0,47}$/;

/** A key that is safe to index answers by. */
export function isInputKey(key: string): boolean {
  return INPUT_KEY.test(key) && !Object.hasOwn(Object.prototype, key);
}

const MAX_JURISDICTION_DEPTH = 4;
const SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Normalizes a jurisdiction path: an ISO 3166-1 country code, then narrower
 * places ("us/ca/alameda"). Returns null if it isn't one.
 */
export function parseJurisdiction(raw: string): string | null {
  const segments = raw.trim().toLowerCase().split("/");
  if (
    segments.length > MAX_JURISDICTION_DEPTH ||
    !/^[a-z]{2}$/.test(segments[0]) ||
    !segments.every((segment) => segment.length <= 40 && SEGMENT.test(segment))
  ) {
    return null;
  }
  return segments.join("/");
}

/** The jurisdiction and every one containing it, narrowest first. */
export function jurisdictionChain(jurisdiction: string): string[] {
  const segments = jurisdiction.split("/");
  return segments.map((_, i) =>
    segments.slice(0, segments.length - i).join("/"),
  );
}

/** "irs 8822", "IRS-8822" and "Form IRS 8822" are the same form. */
export function normalizeFormId(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/^FORM\b/, "")
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
