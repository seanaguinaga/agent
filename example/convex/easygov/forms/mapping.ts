// From a mapping and a person's answers to what goes in each target, and
// from a mapping to the questions a pack on the form asks. Pure.
import type { Infer } from "convex/values";
import type { Mapping, vLeft } from "./schema";

type Left = Infer<typeof vLeft>;

export type Resolved = {
  /** What to write, by target id: text, or true to tick. */
  values: Record<string, string | boolean>;
  /** What's left for the person, each once. */
  toComplete: Left[];
};

/** The input keys a mapping reads, each once, in the form's order. */
export function mappingInputs(mapping: Mapping): string[] {
  return [...new Set(mapping.flatMap(({ input }) => input ?? []))];
}

/** The options ticked in a "check all that apply" answer. */
export const chosen = (answer: string | undefined) =>
  (answer ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

/**
 * What goes where, for these answers. An answer that isn't there leaves its
 * target blank: nothing is made up to fill a box.
 */
export function resolveMapping(
  mapping: Mapping,
  kinds: Record<string, "text" | "check">,
  answers: Record<string, string>,
): Resolved {
  const values: Resolved["values"] = {};
  const toComplete: Left[] = [];
  for (const entry of mapping) {
    const { target, input, equals, includes, constant, leave } = entry;
    const kind = kinds[target];
    if (!kind) continue;
    if (leave) {
      if (!toComplete.some((other) => other.note === leave.note)) {
        toComplete.push(leave);
      }
      continue;
    }
    if (kind === "check") {
      if (constant !== undefined) values[target] = true;
      else if (!input) continue;
      else if (includes !== undefined) {
        values[target] = chosen(answers[input]).includes(includes);
      } else if (equals !== undefined) {
        values[target] = answers[input] === equals;
      }
      continue;
    }
    const value = constant ?? (input ? answers[input] : undefined);
    if (value) values[target] = value;
  }
  return { values, toComplete };
}

export type FormQuestion = {
  key: string;
  question: string;
  choices?: { value: string; label: string }[];
  multiple?: boolean;
};

/**
 * The questions a pack on the form asks: one for each input. Tick boxes
 * that share an input are one question, and each box is one of its choices.
 * `labelOf` gives the words printed beside a target; `readingLabel` names a
 * profile reading, or returns undefined for a case's own question.
 */
export function mappingQuestions(
  mapping: Mapping,
  kinds: Record<string, "text" | "check">,
  labelOf: (target: string) => string,
  readingLabel: (key: string) => string | undefined,
): FormQuestion[] {
  return mappingInputs(mapping).map((key) => {
    const entries = mapping.filter((entry) => entry.input === key);
    const question =
      readingLabel(key) ??
      entries.find((entry) => entry.question)?.question ??
      labelOf(entries[0].target) ??
      key;
    const boxes = entries.filter((entry) => kinds[entry.target] === "check");
    if (!boxes.length) return { key, question };
    const multiple = boxes.some((entry) => entry.includes !== undefined);
    const options = boxes.map((entry) => ({
      value: (multiple ? entry.includes : entry.equals) ?? "yes",
      label: labelOf(entry.target),
    }));
    // A lone box is a yes or no; its label is the question itself.
    if (options.length === 1 && !multiple) {
      return {
        key,
        question: entries[0].question ?? options[0].label,
        choices: [
          { value: options[0].value, label: "Yes" },
          { value: "no", label: "No" },
        ],
      };
    }
    const choices = options.filter(
      (option, i) => options.findIndex((o) => o.value === option.value) === i,
    );
    return { key, question, choices, ...(multiple && { multiple }) };
  });
}

/**
 * Checks an answer against a question's choices, and tidies it: for "check
 * all that apply", the chosen values in the choices' order. Says what's
 * wrong in words for the person.
 */
export function checkChoice(
  question: Pick<FormQuestion, "choices" | "multiple">,
  value: string,
): { value: string } | { problem: string } {
  const { choices, multiple } = question;
  if (!choices) return { value };
  const allowed = choices.map((choice) => choice.value);
  const problem = `Choose ${multiple ? "any of" : "one of"}: ${allowed.join(", ")}.`;
  if (!multiple) return allowed.includes(value) ? { value } : { problem };
  const picked = chosen(value);
  if (picked.some((part) => !allowed.includes(part))) return { problem };
  return {
    value: allowed.filter((option) => picked.includes(option)).join(","),
  };
}
