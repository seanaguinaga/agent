// What a model is shown of an attached file, and what is kept of what it
// said. Pure, so both limits can be tested without a model.
//
// Neither limit cuts through meaning. A text file too long to show keeps its
// start and end, and says so. What the file states is kept fact by fact, so
// one too many drops a whole fact, never half of one.
import { z } from "zod/v4";
import { clip } from "../text";

/** Almost every letter or notice fits whole. */
export const MAX_TEXT = 100_000;
/** The share of a cut file's budget given to its start. */
const HEAD_SHARE = 0.6;

/**
 * As much of a text file as is shown. A file that fits is shown whole. One
 * that doesn't keeps its start (the sender, date and reference numbers) and
 * its end (the date to act by, the signature), with the gap marked.
 */
export function fitText(
  text: string,
  max = MAX_TEXT,
): { text: string; partial: boolean } {
  if (text.length <= max) return { text, partial: false };
  const headMax = Math.floor(max * HEAD_SHARE);
  const head = text.slice(0, headMax);
  const tail = text.slice(text.length - (max - headMax));
  // Break on a line where one is near, so no line is shown half.
  const headEnd = head.lastIndexOf("\n");
  const tailStart = tail.indexOf("\n");
  const start = headEnd > headMax * 0.9 ? head.slice(0, headEnd) : head;
  const end =
    tailStart >= 0 && tailStart < tail.length * 0.1
      ? tail.slice(tailStart + 1)
      : tail;
  const left = text.length - start.length - end.length;
  return {
    text: `${start}\n[... ${left} characters left out here ...]\n${end}`,
    partial: true,
  };
}

const MAX_WHAT = 300;
const MAX_FACTS = 25;
const MAX_LABEL = 60;
const MAX_VALUE = 300;

/**
 * What a file is, and what it states. The limits are applied by `summaryOf`
 * and not here: a reading that breaks a schema limit is thrown away whole,
 * and a file with thirty facts is better read as its first twenty-five.
 */
export const readingFields = {
  what: z
    .string()
    .describe("One sentence: what the file is, who it is from, and its date."),
  stated: z
    .array(
      z.object({
        label: z.string().describe("What the fact is, e.g. Date to act by."),
        value: z.string().describe("The fact, as the file gives it."),
      }),
    )
    .describe(
      `Each fact the file states that a form might ask for, most important first. Up to ${MAX_FACTS}.`,
    ),
};

type Reading = {
  what: string;
  stated: { label: string; value: string }[];
};

/**
 * The reading as the plain text every later step reads: what the file is,
 * then one fact to a line. Empty if the model said nothing about the file.
 */
export function summaryOf(reading: Reading, partial = false): string {
  const what = clip(reading.what, MAX_WHAT);
  if (!what) return "";
  const facts = reading.stated
    .map(({ label, value }) => ({
      label: clip(label, MAX_LABEL),
      value: clip(value, MAX_VALUE),
    }))
    .filter(({ label, value }) => label && value)
    .slice(0, MAX_FACTS);
  return [
    what,
    partial ? "Only the start and end of this file were read." : "",
    ...facts.map(({ label, value }) => `${label}: ${value}`),
  ]
    .filter(Boolean)
    .join("\n");
}
