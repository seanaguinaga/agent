// A file's words, and where they were read from. A caller asks what a file's
// words are, never how they were got: see WORDS.md. Pure.
import type { Infer } from "convex/values";
import type { Transcript } from "./reader";
import type { ReadStatus, vWords } from "./schema";

export type Words = Infer<typeof vWords>;

/** The words a file is told by: none where it has none. */
export const openingOf = (words: Words): string =>
  words.from === "none" ? "" : words.opening;

/**
 * The words a file is told by: the start and end of its first page that has
 * any. Undefined where no page has, as on a scan.
 *
 * A form prints its code somewhere on page one: at the top, in the footer
 * ("DL 410 FO (REV. 7/2024)" is the page's last line), or between an
 * instruction panel and the form ("MV-232 (2/26)"). So the whole page is
 * kept, unless it is longer than any form's. A cover that is only a picture
 * is passed over.
 */
function openingIn(pages: string[]): string | undefined {
  const first = pages.find((page) => page.trim());
  return first === undefined || first.length <= 12_000
    ? first
    : `${first.slice(0, 10_000)} … ${first.slice(-2_000)}`;
}

/** The words a file carries itself: "unread" where it has none. */
export function wordsIn(pages: string[], xfa: boolean): Words | "unread" {
  const opening = openingIn(pages);
  return opening === undefined
    ? "unread"
    : { from: xfa ? "xfa" : "text", opening };
}

/**
 * Whether what a reader said is the answer, or the next reader is asked.
 * Only words stop it. Each reader has its own account, limits and faults,
 * so "denied" and "tooLarge" are one reader's too: a wrong key shouldn't
 * leave the person without, and "tooLarge" settles a file for good, so it
 * is said only once every reader has declined.
 */
export function after(transcript: Transcript): "stop" | "next" {
  switch (transcript.got) {
    case "text":
      return "stop";
    case "refused":
    case "tooLarge":
    case "unavailable":
    case "failed":
      return "next";
  }
}

/**
 * How long to wait before asking the same reader again, or undefined not
 * to: only for what a short wait may mend, while `waits` and the time
 * `left` to the reader last. Being denied, a file too large and a failure
 * would only happen again.
 */
export function retryIn(
  transcript: Transcript,
  retried: number,
  left: number,
  waits: number[],
): number | undefined {
  const wait = retried < waits.length ? waits[retried] : Infinity;
  const soon = wait < left ? wait : undefined;
  switch (transcript.got) {
    case "text":
    case "tooLarge":
    case "failed":
      return undefined;
    case "unavailable":
      return soon;
    case "refused":
      switch (transcript.why) {
        case "quota":
          return soon;
        case "denied":
          return undefined;
      }
  }
}

/** How a read ended, as the person is told while the work still runs. */
export function readAs(words: Words): ReadStatus {
  switch (words.from) {
    case "text":
    case "xfa":
      return "read";
    case "ocr":
      return words.backup ? "readByBackup" : "read";
    case "none":
      return "unread";
  }
}

/**
 * The words a reader gave for a file that has none of its own, with how
 * they were got: which reader, after how many tries, and whether it was a
 * backup.
 */
export function wordsFrom(
  transcript: Transcript,
  how: { by: string; tries: number; backup: boolean },
): Words {
  switch (transcript.got) {
    case "text": {
      const opening = openingIn(transcript.pages);
      return opening === undefined
        ? { from: "none", why: "blank" }
        : { from: "ocr", opening, ...how };
    }
    case "tooLarge":
      return { from: "none", why: "tooLarge" };
    case "refused":
      return {
        from: "none",
        why: "refused",
        note: `${transcript.why}: ${transcript.note}`,
      };
    case "unavailable":
    case "failed":
      return { from: "none", why: transcript.got, note: transcript.note };
  }
}

/**
 * Whether these bytes need never be read again: they gave words, or were
 * read and have none. Anything else is tried again at the next ask.
 */
export function settled(words: Words): boolean {
  if (words.from !== "none") return true;
  switch (words.why) {
    case "blank":
    case "tooLarge":
      return true;
    case "noReader":
    case "unspent":
    case "refused":
    case "unavailable":
    case "failed":
      return false;
  }
}

/** Whether getting these words cost a read: a reader was asked for them. */
export const costRead = (words: Words): boolean =>
  words.from === "ocr" ||
  (words.from === "none" &&
    words.why !== "noReader" &&
    words.why !== "unspent");
