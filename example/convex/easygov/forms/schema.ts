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

/** What a form's file says about itself, as read from it once. */
export const vReadFacts = v.object({
  pages: v.number(),
  places: v.number(),
  language: v.union(
    v.literal("en"),
    v.literal("es"),
    v.literal("both"),
    v.literal("other"),
    v.literal("unknown"),
  ),
  revision: v.optional(v.number()),
});

/**
 * What a form's file says about itself, now: what was read from it, and
 * whether an expiry it prints has passed. See `facts.ts`.
 */
export const vFormFacts = v.object({
  ...vReadFacts.fields,
  expired: v.optional(v.boolean()),
});

/** A file's words, and where they were read from: see `words.ts`. */
export const vWords = v.union(
  v.object({
    from: v.union(v.literal("text"), v.literal("xfa")),
    opening: v.string(),
  }),
  /**
   * Read by a reader, `by`: see `reader.ts`. `tries` is how many times a
   * reader was asked, and `backup` whether the first in order didn't read
   * it. A row kept before these were recorded has neither.
   */
  v.object({
    from: v.literal("ocr"),
    opening: v.string(),
    by: v.string(),
    tries: v.optional(v.number()),
    backup: v.optional(v.boolean()),
  }),
  /** Read, and there is nothing there to read again. */
  v.object({
    from: v.literal("none"),
    why: v.union(v.literal("blank"), v.literal("tooLarge")),
  }),
  /** Not read yet: tried again at the next ask. */
  v.object({
    from: v.literal("none"),
    why: v.union(
      v.literal("noReader"),
      v.literal("unspent"),
      v.literal("refused"),
      v.literal("unavailable"),
      v.literal("failed"),
    ),
    note: v.string(),
  }),
);

/**
 * What is happening to a scanned form while a reader is asked for its words
 * (`fileWords` in `reader.ts`): shown while the work runs, and not kept.
 * "backup" is the next reader being asked; the last three are how it ended.
 */
export const vReadStatus = v.union(
  v.literal("reading"),
  v.literal("retrying"),
  v.literal("backup"),
  v.literal("read"),
  v.literal("readByBackup"),
  v.literal("unread"),
);
export type ReadStatus = Infer<typeof vReadStatus>;

/** What says a file is a form: see `namedBy` in `sources.ts`. */
export const vNamedBy = v.union(
  v.literal("text"),
  v.literal("xfa"),
  v.literal("ocr"),
  v.literal("link"),
);

/** A link on a page: where it goes, the page's words for it, and its kind. */
export const vPageLink = v.object({
  url: v.string(),
  label: v.string(),
  pdf: v.boolean(),
  /** The heading it sits under, and what the page says it describes. */
  under: v.optional(v.string()),
});

/**
 * How an address last answered. "file": it served a PDF, known by its hash
 * and what it prints; `editionId` is set where the file was kept as a form.
 * "page": it is a web page, and these are its links. Otherwise it gave
 * neither: "gone", it isn't there; "unreachable", no way of asking got an
 * answer; "unusable", what it served can't be read as a form.
 */
const fileAnswer = {
  outcome: v.literal("file"),
  sha256: v.string(),
  words: vWords,
  facts: vReadFacts,
  editionId: v.optional(v.id("formEditions")),
  etag: v.optional(v.string()),
  lastModified: v.optional(v.string()),
};
const pageAnswer = {
  outcome: v.literal("page"),
  links: v.array(vPageLink),
  /** Where a redirect had it served from, if on another host. */
  at: v.optional(v.string()),
};
const failedAnswer = {
  outcome: v.union(
    v.literal("gone"),
    v.literal("unreachable"),
    v.literal("unusable"),
  ),
  note: v.string(),
};
export const vAddressAnswer = v.union(
  v.object(fileAnswer),
  v.object(pageAnswer),
  v.object(failedAnswer),
);

/** When an address answered, how many failures in a row, and who asked. */
const asked = {
  url: v.string(),
  checkedAt: v.number(),
  /** How many times in a row it gave neither a file nor a page. */
  failures: v.number(),
  /** The packet that last asked, which needn't ask again. */
  packet: v.optional(v.string()),
};
export const vHeldAddress = v.union(
  v.object({ ...asked, ...fileAnswer }),
  v.object({ ...asked, ...pageAnswer }),
  v.object({ ...asked, ...failedAnswer }),
);

/** An address's row: how it answered, and the form chosen at it, if any. */
const addressRow = {
  key: v.string(),
  ...asked,
  /** The form a case chose this address for, remembered for the next. */
  chosen: v.optional(
    v.object({
      jurisdiction: v.string(),
      /** The code without its agency, to look the form up by. */
      bare: v.string(),
      code: v.string(),
      at: v.number(),
    }),
  ),
};

export const vPacketPdf = v.object({
  code: v.string(),
  sourceUrl: v.string(),
  ...vFilledDocument.fields,
});

/** The government a site belongs to. See `sites.ts`. */
export const vOwner = v.union(
  v.object({ level: v.literal("national"), country: v.string() }),
  v.object({
    level: v.literal("region"),
    country: v.string(),
    /** ISO 3166-2, in lower case: "us-ca". */
    region: v.string(),
  }),
  v.object({
    level: v.literal("local"),
    country: v.string(),
    region: v.optional(v.string()),
    /** The body's name, as its register gives it. */
    body: v.string(),
  }),
);

const vouched = {
  state: v.literal("vouched"),
  /** The registrable domain: every host under it is the site. */
  domain: v.string(),
  /** Who publishes from it, in words: the agency, where one is named. */
  name: v.string(),
  owner: vOwner,
};

/** A site as an official register vouches for it. */
export const vRegistered = v.object({
  ...vouched,
  via: v.object({ kind: v.literal("register"), register: v.literal("cisa") }),
});

/** A site on a suffix its country keeps for government, judged whose. */
export const vSuffixed = v.object({
  ...vouched,
  via: v.object({ kind: v.literal("suffix"), suffix: v.string() }),
});

/** A site on a hand-kept line, with its evidence. See `governments.ts`. */
export const vHandKept = v.object({
  ...vouched,
  via: v.object({ kind: v.literal("hand"), note: v.string() }),
});

/**
 * What, beyond a government's page linking a site, says the site is that
 * government's: it links back to one of the government's sites, a second of
 * those sites links it, or one of the government's hosts redirects to it.
 */
export const vSupport = v.union(
  v.literal("back"),
  v.literal("second"),
  v.literal("redirect"),
);

/** A site its government's page links, judged its own, with support. */
export const vLinked = v.object({
  ...vouched,
  via: v.object({
    kind: v.literal("link"),
    /** The government's page that links it. */
    from: v.string(),
    /** A second of the government's sites' pages that links it. */
    also: v.optional(v.string()),
    support: vSupport,
    /** How many links it is from a register, suffix or hand site. */
    steps: v.number(),
  }),
  /** True once a re-check found what vouched for it gone: see `rechecked`. */
  missed: v.optional(v.boolean()),
});

/**
 * A linked site two re-checks in a row found no longer its government's.
 * Kept, so it is never vouched again unasked: only a hand line restores it.
 */
export const vRevoked = v.object({
  state: v.literal("revoked"),
  domain: v.string(),
});

/**
 * A site judged not to be a government's: a contractor's, nobody could tell
 * whose, nothing but the link supports it, or it is too many links from a
 * site that needs no link.
 */
export const vDeclined = v.object({
  state: v.literal("declined"),
  domain: v.string(),
  why: v.union(
    v.literal("contractor"),
    v.literal("unsure"),
    v.literal("unsupported"),
    v.literal("far"),
  ),
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
     * No longer written: a chosen address is now remembered on its
     * `formAddresses` row. Kept so documents that still carry it deploy;
     * remove it once `clearChosenAt` has run everywhere.
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
    .index("by_sourceUrl", ["sourceUrl"]),

  /**
   * An official address, and how it last answered: with a file, a page of
   * links, or neither. One row per address, so every form and case that
   * leads to it shares what is known. See `stands` for when it is asked
   * again.
   */
  formAddresses: defineTable(
    v.union(
      v.object({
        ...addressRow,
        ...fileAnswer,
        /**
         * A row kept before files had `words` has only its `opening`. Make
         * `words` required and drop `opening` once `wordsFromOpening` has
         * run everywhere.
         */
        words: v.optional(vWords),
        opening: v.optional(v.string()),
      }),
      v.object({ ...addressRow, ...pageAnswer }),
      v.object({ ...addressRow, ...failedAnswer }),
    ),
  )
    .index("by_key", ["key"])
    .index("by_sha256", ["sha256"])
    .index("by_chosen_jurisdiction_and_chosen_bare", [
      "chosen.jurisdiction",
      "chosen.bare",
    ]),

  /**
   * What is kept of sites, by registrable domain (see `sites.ts`): those a
   * register vouches for, and those on a government's suffix or linked from
   * its pages as they were judged. `at` is when the register last listed
   * it, or when it was judged: a linked site's vouch lapses 90 days on.
   */
  sites: defineTable(
    v.union(
      v.object({ ...vRegistered.fields, at: v.number() }),
      v.object({ ...vSuffixed.fields, at: v.number() }),
      v.object({ ...vLinked.fields, at: v.number() }),
      v.object({ ...vDeclined.fields, at: v.number() }),
      v.object({ ...vRevoked.fields, at: v.number() }),
    ),
  )
    .index("by_domain", ["domain"])
    .index("by_state_and_at", ["state", "at"])
    .index("by_via_kind_and_at", ["via.kind", "at"]),

  /** A hosted browser in use. Expires on its own if its work died. */
  browserLeases: defineTable({ expiresAt: v.number() }).index("by_expiresAt", [
    "expiresAt",
  ]),

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
    .index("by_formId_and_sha256", ["formId", "sha256"])
    // The same bytes are one file, whichever address they came from.
    .index("by_sha256", ["sha256"]),
};
