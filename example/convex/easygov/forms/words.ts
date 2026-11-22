// A file's words, and where they were read from. A caller asks what a file's
// words are, never how they were got: see WORDS.md. Pure.
import type { Infer } from "convex/values";
import type { vWords } from "./schema";

export type Words = Infer<typeof vWords>;

/** The words a file is told by: none where it has none. */
export const openingOf = (words: Words): string =>
  words.from === "none" ? "" : words.opening;

/**
 * The words a file carries itself: "unread" where no page has any, as on a
 * scan. They are the start and end of the first page that has words.
 *
 * A form prints its code somewhere on page one: at the top, in the footer
 * ("DL 410 FO (REV. 7/2024)" is the page's last line), or between an
 * instruction panel and the form ("MV-232 (2/26)"). So the whole page is
 * kept, unless it is longer than any form's. A cover that is only a picture
 * is passed over.
 */
export function wordsIn(pages: string[], xfa: boolean): Words | "unread" {
  const first = pages.find((page) => page.trim());
  if (!first) return "unread";
  const opening =
    first.length <= 12_000
      ? first
      : `${first.slice(0, 10_000)} … ${first.slice(-2_000)}`;
  return { from: xfa ? "xfa" : "text", opening };
}
