// Pure helpers over a case's answers.
import type { Signal } from "../packs/schema";
import { sha256Hex } from "../hash";

export type Answers = Record<string, string>;

/**
 * A SHA-256 of the answers and files. The same ones always give the same
 * hash, whatever order they came in, and the hash holds none of them.
 */
export function fingerprint(
  answers: Answers,
  files: { storageId: string; key?: string }[] = [],
): string {
  const sorted = (pairs: [string, string][]) =>
    pairs.sort(([a], [b]) => (a < b ? -1 : 1));
  const given = sorted(Object.entries(answers));
  // A file is its contents and what it was attached as.
  const attached = sorted(
    files.map(({ storageId, key }) => [storageId, key ?? ""]),
  );
  return sha256Hex(JSON.stringify(attached.length ? [given, attached] : given));
}

/**
 * The inputs still unanswered. An empty answer is unanswered, unless it was
 * read from the profile (`following`): there, "" says the person has none,
 * such as a middle name.
 */
export function missingInputs(
  required: string[],
  answers: Answers,
  following: string[] = [],
): string[] {
  return required.filter(
    (key) =>
      answers[key] === undefined ||
      (answers[key] === "" && !following.includes(key)),
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The time of a YYYY-MM-DD date, or null if it isn't a real one. */
function parseDate(text: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const time = Date.parse(`${text}T00:00:00Z`);
  // "2026-02-31" parses in some engines: it must come back as itself.
  return Number.isNaN(time) || formatDate(time) !== text ? null : time;
}

function formatDate(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

export function isDate(text: string): boolean {
  return parseDate(text) !== null;
}

/** Today, as YYYY-MM-DD. */
export function today(now: number): string {
  return formatDate(now);
}

/** The date `days` after a YYYY-MM-DD date, or undefined if it isn't one. */
export function addDays(date: string, days: number): string | undefined {
  const time = parseDate(date);
  return time === null ? undefined : formatDate(time + days * DAY_MS);
}

/** Whether the answers pass a pack's check. `on` is today, as YYYY-MM-DD. */
export function passes(signal: Signal, answers: Answers, on: string): boolean {
  const value = answers[signal.input];
  if (value === undefined) return false;
  if ("equals" in signal) return value === signal.equals;
  if ("atLeast" in signal) {
    return value.trim() !== "" && Number(value) >= signal.atLeast;
  }
  const then = parseDate(value);
  const now = parseDate(on);
  if (then === null || now === null) return false;
  const daysAgo = (now - then) / DAY_MS;
  return daysAgo >= 0 && daysAgo <= signal.withinDays;
}

/** What an answer to `key` must look like, for the checks that read it. */
export function answerProblem(
  value: string,
  kind: "date" | "number" | undefined,
): string | null {
  if (kind === "date" && !isDate(value)) return "Use a date like 2026-10-01.";
  if (kind === "number" && (value.trim() === "" || isNaN(Number(value)))) {
    return "Use a number.";
  }
  return null;
}

/** The `{{key}}` placeholders in a letter. */
export function placeholders(letter: string): string[] {
  return [...letter.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]);
}

/** A letter with each `{{key}}` replaced by its answer. */
export function renderLetter(letter: string, answers: Answers): string {
  return letter.replace(/\{\{(\w+)\}\}/g, (_, key) => answers[key] ?? "");
}
