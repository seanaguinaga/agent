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
