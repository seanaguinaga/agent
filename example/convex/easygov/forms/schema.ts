// Official forms, and each edition of them we have fetched.
import { defineTable } from "convex/server";
import { v, type Infer } from "convex/values";

/** A place on the form a value can go. See `pdf.ts`. */
export const vTarget = v.object({
  id: v.string(),
  page: v.number(),
  x: v.number(),
  y: v.number(),
  w: v.number(),
  h: v.number(),
  kind: v.union(v.literal("text"), v.literal("check")),
  source: v.union(v.literal("field"), v.literal("region")),
  field: v.optional(v.string()),
  /**
   * For a box the PDF itself groups with others under one field: the value
   * that turns this one on. Only one box of such a group can be ticked.
   */
  option: v.optional(v.string()),
  label: v.string(),
  maxLength: v.optional(v.number()),
});

/** Why a place is left for the person, and what to tell them. */
export const vLeft = v.object({
  /**
   * "signature": theirs to sign and date. "confidential": a value we don't
   * hold and won't ask for here, such as a Social Security number.
   */
  why: v.union(v.literal("signature"), v.literal("confidential")),
  note: v.string(),
});

/**
 * What goes in one target. Exactly one of:
 * - `input`: an answer, by input key. A profile reading (`fullName`) is read
 *   from the profile; any other key is a question for the case, asked in
 *   the words of `question`.
 *   A tick box also says when it's ticked: `equals` when the answer is this
 *   option (pick one, or a lone yes/no), `includes` when this option is
 *   among the answers (check all that apply). Boxes that share an input are
 *   one question, and each box's option is one of its choices.
 * - `constant`: the same on every copy, e.g. the box for the kind of return.
 * - `leave`: left for the person to complete, and why.
 * A target with no entry is left blank and not mentioned.
 */
/** An official form, filled in. */
export const vFilledDocument = v.object({
  storageId: v.id("_storage"),
  /** Values that weren't written, each with why. Never cut short to fit. */
  omissions: v.array(v.object({ label: v.string(), reason: v.string() })),
  /** What's left for the person, and why. */
  toComplete: v.array(vLeft),
});

export const vMappingEntry = v.object({
  target: v.string(),
  input: v.optional(v.string()),
  question: v.optional(v.string()),
  equals: v.optional(v.string()),
  includes: v.optional(v.string()),
  constant: v.optional(v.string()),
  leave: v.optional(vLeft),
});
export const vMapping = v.array(vMappingEntry);
export type Mapping = Infer<typeof vMapping>;

/** How a form's bytes were got. See `sources.ts`. */
export const vVia = v.union(v.literal("request"), v.literal("browser"));
export const vAttempt = v.object({
  via: vVia,
  url: v.string(),
  ok: v.boolean(),
  note: v.string(),
});

export const vPacketPdf = v.object({
  code: v.string(),
  sourceUrl: v.string(),
  ...vFilledDocument.fields,
});

export default {
  formBlueprints: defineTable({
    editionId: v.id("formEditions"),
    targets: v.array(vTarget),
    mapping: vMapping,
  }).index("by_editionId", ["editionId"]),
  /** A form we know where to get: a small registry, added to by hand. */
  forms: defineTable({
    /** As people write it: "IRS-8822". */
    code: v.string(),
    title: v.string(),
    jurisdiction: v.string(),
    /** Where the authority publishes it. Fetched from here and nowhere else. */
    sourceUrl: v.string(),
    /** Other places the same authority publishes the same file. */
    alternateUrls: v.optional(v.array(v.string())),
    /**
     * When this address was last the one chosen for the form, over every
     * other file found for it. Only a chosen address is remembered for the
     * next case: a translation fetched along the way isn't.
     */
    chosenAt: v.optional(v.number()),
    /**
     * The last fetch: every way and address tried, in order. A form that
     * can't be reached says so here, with why.
     */
    lastFetch: v.optional(
      v.object({
        at: v.number(),
        ok: v.boolean(),
        attempts: v.array(vAttempt),
      }),
    ),
  })
    .index("by_code", ["code"])
    .index("by_jurisdiction_and_chosenAt", ["jurisdiction", "chosenAt"])
    .index("by_sourceUrl", ["sourceUrl"]),

  /**
   * The bytes of a form as fetched, known by their hash. A form that changes
   * upstream is a new edition; the old one stays for the cases built on it.
   */
  formEditions: defineTable({
    formId: v.id("forms"),
    sha256: v.string(),
    storageId: v.id("_storage"),
    /** When the source last served these same bytes. */
    checkedAt: v.number(),
    /** How these bytes were first got: a plain request, or a real browser. */
    obtained: v.optional(v.object({ via: vVia, url: v.string() })),
    /**
     * True when the published file was protected without a password and
     * allowed its forms to be filled, and that protection was removed. The
     * stored file is the opened one; `sha256` is of the file as published.
     */
    opened: v.optional(v.boolean()),
    /** The revision printed on it, e.g. "Rev. February 2021". */
    edition: v.optional(v.string()),
    pages: v.number(),
    /** False for a flat PDF, whose targets were found on the page. */
    fillable: v.boolean(),
    targets: v.array(vTarget),
    mapping: vMapping,
    /**
     * A mapping is drafted by a model and used only once a person has
     * reviewed it. It's frozen with these bytes: a new edition starts again.
     */
    mappingStatus: v.union(
      v.literal("none"),
      v.literal("drafted"),
      v.literal("reviewed"),
    ),
    /**
     * That the source served these bytes says they're published, not that
     * the authority still accepts them. "confirmed" needs a page that says
     * so, kept as evidence; until then a filled copy is a draft.
     */
    currency: v.union(
      v.object({ status: v.literal("unconfirmed") }),
      v.object({
        status: v.literal("confirmed"),
        evidenceUrl: v.string(),
        excerpt: v.string(),
      }),
    ),
  })
    // Kept beside the index below for its order: newest edition first.
    // eslint-disable-next-line @convex-dev/no-duplicate-indexes
    .index("by_formId", ["formId"])
    .index("by_formId_and_sha256", ["formId", "sha256"]),
};
