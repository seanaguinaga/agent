// Getting a form's bytes from its authority, by whatever way works. Pure:
// the ways are passed in, so the order and the bookkeeping are tested
// without a network.
//
// What's needed is the exact bytes the authority publishes, and to be able
// to say where they came from. So every way starts from the authority's own
// address: first a plain request, then a real browser opening the same
// address. A person is never asked to fetch a form for us.

/** How a form's bytes were got. */
export type Via = "request" | "browser";

/** One try at one address, and how it went. */
export type Attempt = { via: Via; url: string; ok: boolean; note: string };

export type Obtained = {
  bytes: Uint8Array;
  via: Via;
  url: string;
  attempts: Attempt[];
};

/** A way of fetching an address: its bytes, or a throw saying why not. */
export type Fetcher = (url: string) => Promise<Uint8Array>;

/** Larger than any form we'd fill, small enough to hold in memory. */
export const MAX_BYTES = 20 * 1024 * 1024;

/** Why these bytes aren't a usable PDF, or null if they are. */
export function notAPdf(bytes: Uint8Array): string | null {
  if (bytes.length > MAX_BYTES) return "The file is too large.";
  if (new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") {
    return "It isn't a PDF.";
  }
  return null;
}

/**
 * Whether a form's text names the form: "IRS-8822" is found as "8822",
 * "SS-5" as "SS5". Guards against a site answering with some other document.
 */
export function namesForm(code: string, text: string): boolean {
  const squash = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const parts = code.split(/[\s-]+/).filter(Boolean);
  // Drop a leading agency name ("IRS", "SSA"): the form doesn't print it so.
  const own =
    parts.length > 1 && /^[A-Za-z]+$/.test(parts[0]) ? parts.slice(1) : parts;
  const wanted = squash(own.join(""));
  return wanted.length > 0 && squash(text).includes(wanted);
}

/**
 * Tries each way at each address, cheapest way first, and stops at the first
 * usable PDF. Every try is kept, so a form that can't be reached says why.
 */
export async function obtain(
  urls: string[],
  ways: { request: Fetcher; browser?: Fetcher },
): Promise<Obtained | { attempts: Attempt[] }> {
  const attempts: Attempt[] = [];
  const order: [Via, Fetcher | undefined][] = [
    ["request", ways.request],
    ["browser", ways.browser],
  ];
  for (const [via, fetcher] of order) {
    if (!fetcher) continue;
    for (const url of urls) {
      try {
        const bytes = await fetcher(url);
        const problem = notAPdf(bytes);
        if (!problem) {
          attempts.push({ via, url, ok: true, note: `${bytes.length} bytes` });
          return { bytes, via, url, attempts };
        }
        attempts.push({ via, url, ok: false, note: problem });
      } catch (error) {
        const note = error instanceof Error ? error.message : String(error);
        attempts.push({ via, url, ok: false, note: note.slice(0, 200) });
      }
    }
  }
  return { attempts };
}

const LANGUAGE = /[-_](?:SP|SPA|SPAN|SPANISH|ES|ESP)(?=[-_.])/i;

/**
 * The addresses to try for a form, likeliest first. An authority often links
 * only a translation of a form, and publishes the English one beside it
 * under the same name without the language marker: "FORM-10-SP.pdf" beside
 * "FORM-10.pdf", or "/es/forms/" beside "/en/forms/". So an address that
 * carries a marker is tried without it first, then as it was given.
 */
export function leadsFrom(url: string): string[] {
  const cut = url.search(/[?#]/);
  const [path, rest] =
    cut < 0 ? [url, ""] : [url.slice(0, cut), url.slice(cut)];
  const slash = path.lastIndexOf("/") + 1;
  const [folder, file] = [path.slice(0, slash), path.slice(slash)];
  const inSpanish = /\/es\//i;
  const variants = [
    ...(LANGUAGE.test(file) ? [folder + file.replace(LANGUAGE, "")] : []),
    ...(inSpanish.test(folder)
      ? [folder.replace(inSpanish, "/en/"), folder.replace(inSpanish, "/")].map(
          (english) => english + file,
        )
      : []),
  ].map((variant) => variant + rest);
  return [...new Set([...variants, url])];
}

/** A link on an authority's page: where it goes, and what the page calls it. */
export type LabelledLink = { url: string; label: string };

/**
 * The PDF links on a page, each with the words the page puts on it. Those
 * words are the authority saying which form the file is: the one statement
 * of that which doesn't have to be inferred from a filename.
 */
export function labelledPdfLinks(html: string, page: string): LabelledLink[] {
  const words = (text: string) =>
    text
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;|&#160;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&[a-z]+;|&#\d+;/gi, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160);
  const found = new Map<string, string>();
  const anchors = html.matchAll(
    /<a\b([^>]*?)href\s*=\s*["']([^"'#]+)["']([^>]*)>([\s\S]*?)<\/a>/gi,
  );
  for (const [, before, href, after, inner] of anchors) {
    let url: string;
    try {
      url = new URL(href.replace(/&amp;/g, "&"), page).href;
    } catch {
      continue;
    }
    if (!/pdf/i.test(url.split("?")[0])) continue;
    const named = `${before} ${after}`.match(
      /(?:title|aria-label)\s*=\s*["']([^"']+)["']/i,
    )?.[1];
    const label = words(inner) || words(named ?? "");
    if (!found.get(url)) found.set(url, label);
  }
  return [...found].map(([url, label]) => ({ url, label }));
}

/**
 * The links most likely to be a form, most likely first: those whose words
 * or filename share the most parts with its code. This only narrows a long
 * page to a list short enough to choose from; it decides nothing.
 */
export function shortlist(
  links: LabelledLink[],
  code: string,
  limit = 15,
): LabelledLink[] {
  const parts = (text: string) =>
    new Set(text.toUpperCase().match(/[A-Z]+|\d+/g) ?? []);
  const wanted = [...parts(code.replace(/\bforms?\b/gi, ""))];
  if (!wanted.length) return [];
  return links
    .map((link, index) => {
      const file = link.url.split(/[?#]/)[0].split("/").pop() ?? "";
      const seen = parts(`${link.label} ${file}`);
      const hits = wanted.filter((part) => seen.has(part)).length;
      return { link, index, hits };
    })
    .filter(({ hits }) => hits > 0)
    .sort((a, b) => b.hits - a.hits || a.index - b.index)
    .slice(0, limit)
    .map(({ link }) => link);
}

/** A code cut at its separators, without the word "form". */
function codeParts(text: string): string[] {
  return text
    .toUpperCase()
    .replace(/FORMS?/g, "")
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
}

/** The parts after a leading one that is only letters: the agency. */
function withoutAgency(parts: string[]): string[][] {
  return /^[A-Z]+$/.test(parts[0] ?? "") && parts.length > 1
    ? [parts.slice(1)]
    : [];
}

/** A code as one string: whole, and without its agency if it names one. */
function codeKeys(code: string): { whole: string; bare: string[] } {
  const parts = codeParts(code);
  return {
    whole: parts.join(""),
    bare: withoutAgency(parts).map((rest) => rest.join("")),
  };
}

/**
 * Whether two codes name one form, however each is written: "IRS-8822" and
 * "Form 8822", "DL 410 FO" and "DL-410-FO", "USCIS-I-864" and "I-864". A
 * suffix makes another form ("8822-B" is not "8822"), and so does another
 * series: "DWC-1" and "RCI-1" share a number and nothing else. So the agency
 * may be missing from one side, never dropped from both.
 */
export function sameFormCode(a: string, b: string): boolean {
  const [x, y] = [codeKeys(a), codeKeys(b)];
  if (!/\d/.test(x.whole) || !/\d/.test(y.whole)) return false;
  return (
    x.whole === y.whole || x.bare.includes(y.whole) || y.bare.includes(x.whole)
  );
}

/** Hosts a form may be fetched from: the authority's own. */
export function isOfficialHost(url: string): boolean {
  try {
    const { protocol, hostname, username, password, port } = new URL(url);
    return (
      protocol === "https:" &&
      !username &&
      !password &&
      (!port || port === "443") &&
      /(?:^|\.)(?:gov|mil)$|\.(?:gov|us)$|(?:^|\.)ca\.gov$/.test(hostname)
    );
  } catch {
    return false;
  }
}
