// What counts as one address, one form and one file, what a page says of
// its links and of itself, and when an address is asked again. Pure.

/** How a form's bytes were got. */
export type Via = "request" | "browser";

/**
 * Whether words carry a form's number: the longest number in its code,
 * standing alone. A number under three digits is on every page, and says
 * nothing. A letter glued to it makes another form: "I-864A" doesn't carry
 * I-864's number.
 */
export function carriesNumber(code: string, text: string): boolean {
  const [number] = (code.match(/\d+/g) ?? []).sort(
    (a, b) => b.length - a.length,
  );
  return (
    !!number &&
    number.length >= 3 &&
    new RegExp(`(?<![\\dA-Z])${number}(?![\\dA-Z])`, "i").test(text)
  );
}

/** What says a file is a form: its own words, or the authority's link alone. */
export type NamedBy = "text" | "link";

/**
 * What says a file is the form `code`: undefined if nothing does.
 *
 * Its text does if it prints the whole code. It also does if the authority's
 * own page links it as the form and both say so: the page's words for the
 * link (`linkedAs`: the link's own and the heading it sits under, never its
 * file name) carry the form's number, and so does the file. An authority
 * renames a form ("SSA-561-U2" became "SSA-561") and goes on linking its
 * file under the one heading, so the file may no longer print the code as
 * it was asked for; but the page and the file each have to name it, so a
 * link picked wrongly isn't let through by its file alone.
 *
 * The link alone does only for a file with no words to read at all, such as
 * a scan (`opening` is empty): the link has to be `trusted` (see
 * `VERY_SURE`), and its words have to print the whole code. A file whose
 * words don't name the form is never the form, whatever links it.
 */
export function namedBy(
  code: string,
  opening: string,
  linkedAs = "",
  trusted = false,
): NamedBy | undefined {
  if (!opening) {
    return trusted && namesForm(code, linkedAs) ? "link" : undefined;
  }
  const says =
    namesForm(code, opening) ||
    (carriesNumber(code, linkedAs) && carriesNumber(code, opening));
  return says ? "text" : undefined;
}

/** Larger than any form we'd fill, small enough to hold in memory. */
export const MAX_BYTES = 20 * 1024 * 1024;

/**
 * A response's body, up to `limit` bytes, and whether it was longer and cut
 * there. No more than `limit` is ever held.
 */
export async function readUpTo(
  response: Response,
  limit: number,
): Promise<{ bytes: Uint8Array; cut: boolean }> {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let cut = false;
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = limit - length;
    chunks.push(value.subarray(0, room));
    length += Math.min(value.length, room);
    if (value.length > room) {
      cut = true;
      await reader.cancel();
      break;
    }
  }
  const bytes = new Uint8Array(length);
  chunks.reduce((at, chunk) => (bytes.set(chunk, at), at + chunk.length), 0);
  return { bytes, cut };
}

/** Why these bytes aren't a usable PDF, or null if they are. */
export function notAPdf(bytes: Uint8Array): string | null {
  if (new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") {
    return "It isn't a PDF.";
  }
  return null;
}

/**
 * Whether text prints a form's code: every part of it, in order, standing
 * alone. "SS-5" is found as "SS 5" or "SS5", never as a stray "5"; and a
 * suffix makes another form, so "Form 8822-B" doesn't name 8822, nor
 * "I-864A" I-864. A leading agency the form may not print ("IRS-8822" as
 * "Form 8822") can be missing, but only where what is left still says
 * which form it is: a series ("SSA SS-5" as "SS-5") or a long number. A
 * form known only by its title is named by the whole title.
 */
export function namesForm(code: string, text: string): boolean {
  const parts = codeParts(code);
  if (!parts.length) return false;
  const [rest] = withoutAgency(parts);
  // A form known by its title alone is named by that title, word for word.
  const sep = parts.some((part) => /\d/.test(part))
    ? "[^A-Z0-9]{0,3}"
    : "[^A-Z0-9]+";
  const spelled = (each: string[]) => each.join(sep);
  const optional =
    rest &&
    /\d/.test(rest.join("")) &&
    (/^[A-Z]/.test(rest[0]) || /\d{3,}/.test(rest.join("")));
  const pattern = optional
    ? `(?:${parts[0]}${sep})?${spelled(rest)}`
    : spelled(parts);
  return new RegExp(`(?<![A-Z0-9])${pattern}(?![A-Z0-9]|[-–][A-Z0-9])`).test(
    text.toUpperCase(),
  );
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

/**
 * An address as one place to fetch from: its host in lower case, without a
 * fragment. The path is kept as written, since a server may tell two files
 * apart by letter case alone.
 */
export function addressKey(url: string): string {
  try {
    const { host, pathname, search } = new URL(url.trim());
    return host.toLowerCase() + pathname + search;
  } catch {
    return url.trim();
  }
}

/**
 * An address in any letter case. Two spellings of one address are usually
 * one place, so the second is only asked if the first didn't serve a file.
 */
export function looseKey(url: string): string {
  return addressKey(url).toLowerCase();
}

/** Whether two addresses are one place, as written. */
export function sameAddress(a: string, b: string): boolean {
  return !!a && !!b && addressKey(a) === addressKey(b);
}

/**
 * A link on an authority's page: where it goes, what the page calls it, and
 * what it sits under. A page that lists forms often puts the same words on
 * every link ("English PDF", "Download") and names the form in the heading
 * above it, so the heading is as much the page's word for the link as the
 * link's own.
 */
export type LabelledLink = {
  url: string;
  label: string;
  under?: string;
  /** The site of the page the link is on. */
  on?: string;
};

/** A link, and whether it goes to a PDF or to another page. */
export type PageLink = LabelledLink & { pdf: boolean };

/** The words of a piece of a page, without its markup. */
const words = (text: string) =>
  text
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&[a-z]+;|&#\d+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);

/** What a site says of itself on a page: its title, and its footer's words. */
export function selfDescribed(html: string) {
  const piece = (tag: string) =>
    words(
      html.match(
        new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}\\s*>`, "i"),
      )?.[1] ?? "",
    );
  const [title, footer] = [piece("title"), piece("footer")];
  return { ...(title && { title }), ...(footer && { footer }) };
}

/**
 * The links on a page, each with the words the page puts on it. Those words
 * are the authority saying what the link is: for a PDF, which form the file
 * is, the one statement of that which doesn't have to be inferred from a
 * filename; for a page, what a reader would find one link further on.
 */
export function labelledLinks(html: string, page: string): PageLink[] {
  // Each heading, where it starts: a link sits under the last one before it.
  const headings = [
    ...html.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi),
  ].map((match) => ({ at: match.index, text: words(match[2]) }));
  let heading = -1;
  const found = new Map<string, PageLink>();
  const anchors = html.matchAll(
    /<a\b([^>]*?)href\s*=\s*["']([^"'#]+)["']([^>]*)>([\s\S]*?)<\/a>/gi,
  );
  for (const anchor of anchors) {
    const [, before, href, after, inner] = anchor;
    while (headings[heading + 1]?.at < anchor.index) heading++;
    let url: string;
    try {
      url = new URL(href.replace(/&amp;/g, "&"), page).href;
    } catch {
      continue;
    }
    if (!/^https?:/.test(url)) continue;
    const named = `${before} ${after}`.match(
      /(?:title|aria-label)\s*=\s*["']([^"']+)["']/i,
    )?.[1];
    const label = words(inner) || words(named ?? "");
    // What the page says the link describes, where it says: often the
    // heading's own name with the kind of file, as in "ssa-561 form".
    const describes = `${before} ${after}`.match(
      /aria-describedby\s*=\s*["']([^"']+)["']/i,
    )?.[1];
    const under = [headings[heading]?.text, describes && words(describes)]
      .filter(Boolean)
      .join(" · ");
    const key = addressKey(url);
    if (!found.get(key)?.label) {
      found.set(key, {
        url,
        label,
        pdf: /pdf/i.test(url.split("?")[0]),
        ...(under && { under }),
      });
    }
  }
  return [...found.values()];
}

const HOUR = 60 * 60 * 1000;

/**
 * Whether what an address last answered still stands, so it isn't asked
 * again. A page's links stand for a day. A failure stands for an hour, and
 * twice as long each time it fails again, up to a week. A file never stands
 * on its age: an authority can publish a new edition at the same address, so
 * it is asked each time whether the file has changed.
 */
export function stands(
  held: { outcome: string; checkedAt: number; failures: number },
  now: number,
): boolean {
  const age = now - held.checkedAt;
  if (held.outcome === "file") return false;
  if (held.outcome === "page") return age < 24 * HOUR;
  return age < Math.min(HOUR * 2 ** (held.failures - 1), 7 * 24 * HOUR);
}

/** Whether bytes that aren't a PDF are a web page. */
export function isWebPage(bytes: Uint8Array): boolean {
  const start = new TextDecoder().decode(bytes.slice(0, 2000)).toLowerCase();
  return /<!doctype html|<html[\s>]|<head[\s>]|<body[\s>]/.test(start);
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
      const seen = parts(`${link.label} ${link.under ?? ""} ${file}`);
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
 * A code without its agency, as one string: what forms are looked up by.
 * Two codes for one form share it; so can two forms, which `sameFormCode`
 * then tells apart.
 */
export function bareCode(code: string): string {
  const { whole, bare } = codeKeys(code);
  return bare[0] ?? whole;
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
