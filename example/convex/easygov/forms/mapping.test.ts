import { describe, expect, test } from "vitest";
import {
  checkChoice,
  mappingInputs,
  mappingQuestions,
  resolveMapping,
} from "./mapping";

const kinds = {
  name: "text",
  old: "text",
  kind: "check",
  joint: "check",
  sign: "text",
  ssn: "text",
  individual: "check",
  gift: "check",
  single: "check",
  married: "check",
} as const;
const sign = { why: "signature" as const, note: "Sign and date the form." };
const mapping = [
  { target: "kind", constant: "yes" },
  { target: "name", input: "fullName" },
  { target: "old", input: "homeAddressLine" },
  { target: "joint", input: "filingJointly", equals: "yes" },
  { target: "sign", leave: sign },
  { target: "ssn", leave: { why: "confidential" as const, note: "Your SSN." } },
  { target: "gone", input: "fullName" },
];
const groups = [
  {
    target: "individual",
    input: "returns",
    includes: "individual",
    question: "Which returns does this change affect?",
  },
  { target: "gift", input: "returns", includes: "gift" },
  {
    target: "single",
    input: "status",
    equals: "single",
    question: "What is your filing status?",
  },
  { target: "married", input: "status", equals: "married" },
];

test("answers go where the mapping says; a missing one leaves a blank", () => {
  expect(mappingInputs(mapping)).toEqual([
    "fullName",
    "homeAddressLine",
    "filingJointly",
  ]);
  expect(
    resolveMapping(mapping, kinds, {
      fullName: "Ada Lovelace",
      filingJointly: "no",
    }),
  ).toEqual({
    values: { kind: true, name: "Ada Lovelace", joint: false },
    // What's left for the person says why: theirs to sign, or ours not to hold.
    toComplete: [sign, { why: "confidential", note: "Your SSN." }],
  });
  expect(
    resolveMapping(mapping, kinds, { filingJointly: "yes" }).values,
  ).toEqual({ kind: true, joint: true });
});

describe("a group of tick boxes is one question", () => {
  test("pick one ticks the box whose option is the answer", () => {
    expect(resolveMapping(groups, kinds, { status: "married" }).values).toEqual(
      {
        individual: false,
        gift: false,
        single: false,
        married: true,
      },
    );
  });

  test("check all that apply ticks every box among the answers", () => {
    expect(
      resolveMapping(groups, kinds, { returns: "gift, individual" }).values,
    ).toMatchObject({ individual: true, gift: true });
    expect(
      resolveMapping(groups, kinds, { returns: "gift" }).values,
    ).toMatchObject({ individual: false, gift: true });
  });

  test("becomes a question with its boxes as choices", () => {
    const labels: Record<string, string> = {
      individual: "Individual income tax returns",
      gift: "Gift, estate, or transfer tax returns",
      single: "Single",
      married: "Married filing jointly",
      joint: "Check here if this is a joint return",
      name: "3a Your name",
    };
    const questions = mappingQuestions(
      [...groups, mapping[3], mapping[1]],
      kinds,
      (target) => labels[target],
      (key) => (key === "fullName" ? "Full legal name" : undefined),
    );
    expect(questions).toEqual([
      {
        key: "returns",
        question: "Which returns does this change affect?",
        multiple: true,
        choices: [
          { value: "individual", label: "Individual income tax returns" },
          { value: "gift", label: "Gift, estate, or transfer tax returns" },
        ],
      },
      {
        key: "status",
        question: "What is your filing status?",
        choices: [
          { value: "single", label: "Single" },
          { value: "married", label: "Married filing jointly" },
        ],
      },
      // A lone box is a yes or no, asked in the words beside it.
      {
        key: "filingJointly",
        question: "Check here if this is a joint return",
        choices: [
          { value: "yes", label: "Yes" },
          { value: "no", label: "No" },
        ],
      },
      { key: "fullName", question: "Full legal name" },
    ]);
  });

  test("an answer has to be among the choices", () => {
    const one = {
      choices: [
        { value: "single", label: "" },
        { value: "married", label: "" },
      ],
    };
    expect(checkChoice(one, "married")).toEqual({ value: "married" });
    expect(checkChoice(one, "divorced")).toEqual({
      problem: "Choose one of: single, married.",
    });
    const many = { ...one, multiple: true };
    // Tidied into the choices' order, however it was typed.
    expect(checkChoice(many, "married, single")).toEqual({
      value: "single,married",
    });
    expect(checkChoice(many, "")).toEqual({ value: "" });
    expect(checkChoice(many, "single,other")).toHaveProperty("problem");
    expect(checkChoice({}, "anything")).toEqual({ value: "anything" });
  });
});
