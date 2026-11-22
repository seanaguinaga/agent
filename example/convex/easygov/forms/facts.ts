// What a form's file says about itself, and how files that claim to be the
// same form are told apart. Pure: words in, facts out.
//
// Several files can name one form: an old revision and a new one, a
// translation, a booklet about it. None of that needs a judgment call. The
// file prints its revision, is written in a language, and either has places
// to write in or doesn't. So every candidate is read for those facts, and
// the best is chosen by them, whichever order the candidates were found in.
// The one thing a file can't say is which form it is: that comes from the
// authority's own link to it, where there is one (see `chooseLink`).

export type Language = "en" | "es" | "both" | "other" | "unknown";

export type FormFacts = {
  pages: number;
  /** How many places the file has to write in: none on a booklet. */
  places: number;
  language: Language;
  /** The revision the file prints, as YYYYMM. Undefined if it prints none. */
  revision?: number;
  /**
   * True if the file prints a date it expires on, and that date has passed.
   * Worked out when the facts are given, never kept: see `ReadFacts`.
   */
  expired?: boolean;
};

/** What is read from a file once, and kept: everything but whether it has expired. */
export type ReadFacts = Omit<FormFacts, "expired">;

const ENGLISH = [
  "the",
  "and",
  "of",
  "your",
  "you",
  "for",
  "this",
  "with",
  "are",
  "is",
];
const SPANISH = [
  "el",
  "la",
  "los",
  "las",
  "del",
  "su",
  "para",
  "que",
  "con",
  "usted",
  "una",
];

/** The language a page is written in, from its commonest small words. */
export function languageOf(words: string): Language {
  // A page with much writing outside the Latin alphabet is a translation,
  // whatever English it also carries: no word list could cover them all.
  const letters = words.match(/\p{L}/gu) ?? [];
  const foreign = letters.filter((letter) => !/\p{Script=Latin}/u.test(letter));
  if (letters.length >= 40 && foreign.length / letters.length >= 0.1) {
    return "other";
  }
  const tokens = words.toLowerCase().match(/[a-záéíóúñü]+/g) ?? [];
  if (tokens.length < 20) return "unknown";
  const share = (list: string[]) =>
    tokens.filter((token) => list.includes(token)).length / tokens.length;
  const [english, spanish] = [share(ENGLISH), share(SPANISH)];
  if (english >= 0.04 && spanish >= 0.04) return "both";
  if (english >= 0.04) return "en";
  if (spanish >= 0.04) return "es";
  return "unknown";
}

const MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];
const year = (digits: string) =>
  digits.length === 4
    ? Number(digits)
    : Number(digits) + (Number(digits) < 70 ? 2000 : 1900);

/** A date as a form prints its revision: "7/2024", "12-18", "12/08/21", "February 2021". */
function dateIn(text: string): number | undefined {
  const full = text.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{4}|\d{2})\b/);
  if (full) return year(full[3]) * 100 + Number(full[1]);
  const short = text.match(/\b(\d{1,2})[/-](\d{4}|\d{2})\b/);
  if (short && Number(short[1]) <= 12)
    return year(short[2]) * 100 + Number(short[1]);
  const named = text.match(/\b([A-Za-z]{3})[a-z]*\.?,?\s+(\d{4})\b/);
  const month = named ? MONTHS.indexOf(named[1].toLowerCase()) : -1;
  if (named && month >= 0) return Number(named[2]) * 100 + month + 1;
  const alone = text.match(/\b(19|20)\d{2}\b/);
  return alone ? Number(alone[0]) * 100 : undefined;
}

/**
 * The revision a form prints, as YYYYMM: the date after "Rev.", "Revised" or
 * "Edition", or a month and year alone in brackets, wherever on the page it
 * is. The latest, if it prints several.
 */
export function revisionOf(words: string): number | undefined {
  const marked = [
    ...words.matchAll(
      /\b(?:rev(?:ised|ision)?|edition|ed)\b\.?[\s(:]*([^)\n]{0,24})/gi,
    ),
    // A month and year alone in brackets, as beside a form's code:
    // "Form SSA-561 (08-2025)".
    ...words.matchAll(/\(\s*(\d{1,2}[/-](?:\d{4}|\d{2}))\s*\)/g),
  ].flatMap(([, after]) => dateIn(after) ?? []);
  return marked.length ? Math.max(...marked) : undefined;
}

const LANGUAGE_ORDER: Record<Language, number> = {
  en: 0,
  both: 0,
  unknown: 1,
  es: 2,
  other: 2,
};

/**
 * Candidates for one form, best first: a file with places to write in before
 * one without, English (or bilingual) before a translation, a current file
 * before one that prints an expiry that has passed, a file with words of its
 * own before a scan a reader read (`namedBy` is "ocr"), and a file on the
 * authority's own site (see `confirms`) before any other. Among the
 * authority's own, the latest revision printed comes first, even before the
 * file its page links: a page can go on linking an edition the authority has
 * replaced, and only the linked file is confirmed (see `backs`). Among the
 * rest, the file the authority's link gives comes first, then the latest
 * revision. Ties keep the order they came in, which is the order the sources
 * can be trusted in.
 */
export function rankForms<
  T extends {
    facts: FormFacts;
    designated?: boolean;
    own?: boolean;
    namedBy?: string;
  },
>(candidates: T[]): T[] {
  const key = ({ facts, designated, own, namedBy }: T) => [
    facts.places > 0 ? 0 : 1,
    LANGUAGE_ORDER[facts.language],
    facts.expired ? 1 : 0,
    namedBy === "ocr" ? 1 : 0,
    own ? 0 : 1,
    own ? -(facts.revision ?? 0) : 0,
    designated ? 0 : 1,
    -(facts.revision ?? 0),
  ];
  return candidates
    .map((candidate, index) => ({ candidate, index, key: key(candidate) }))
    .sort(
      (a, b) =>
        a.key.reduce((order, k, i) => order || k - b.key[i], 0) ||
        a.index - b.index,
    )
    .map(({ candidate }) => candidate);
}

/**
 * Whether a form prints an expiry that has passed: "Expires: 04/24",
 * "Expires 10/31/2027". The last day of the month it names is the last day
 * it holds.
 */
export function expiredBy(words: string, now: number): boolean {
  const printed = words.match(
    /\bExpir(?:es|ation(?: date)?):?\s*(\d{1,2})\s*\/\s*(?:\d{1,2}\s*\/\s*)?(\d{4}|\d{2})\b/i,
  );
  if (!printed) return false;
  const [, month, digits] = printed;
  return Date.UTC(year(digits), Number(month), 1) <= now;
}
