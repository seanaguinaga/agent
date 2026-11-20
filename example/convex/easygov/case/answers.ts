// Pure helpers over a case's answers.
import { DAY_MS, isDate, parseDate } from "../dates";
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

/** A pack's referral check: `when` and each of `orWhen`. */
export function signalsOf(referral: {
  when?: Signal;
  orWhen?: Signal[];
}): Signal[] {
  return [
    ...(referral.when ? [referral.when] : []),
    ...(referral.orWhen ?? []),
  ];
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
