// The graders, against a real draft that had the defects they look for.
import { describe, expect, test } from "vitest";
import { normalizeFormId, parseJurisdiction } from "../packs/schema";
import { draft as draftCases } from "./cases";
import {
  gradeDraft,
  gradeIntake,
  gradePrefill,
  gradeRequest,
  gradeResearch,
  passes,
} from "./grading";

const oakland = draftCases.find((c) => c.id.startsWith("oakland"))!;

// What the model wrote for the Oakland parking ticket, before the prompt
// told it not to mention "the notes".
const letter =
  "I am challenging parking citation {{citation}} because {{reasons}}. My name is {{name}}.";
const live = {
  title: "Oakland Parking Citation Dispute and Administrative Hearing",
  description: "Process for challenging an Oakland parking citation.",
  aliases: [],
  jurisdiction: "us/ca/alameda",
  forms: [],
  inputs: ["citation", "reasons", "name"],
  inputQuestions: [
    { key: "citation", question: "What is your parking citation number?" },
    { key: "reasons", question: "Why are you challenging the citation?" },
    { key: "name", question: "What is your name?" },
  ],
  output: {
    title: "Oakland Parking Citation Dispute",
    checklist: [
      "Challenge the ticket within 21 days of its issue date. The notes do not specify a filing fee; check with the City of Oakland.",
      "For mail, send the letter and a check payable to City of Oakland to Parking Citation Assistance Center - Hearing,",
      "For an in-person request, go to 270 Frank H. Ogawa Plaza, Oakland, CA 94612, or call (800) 500-6484.",
    ],
    letter,
    sources: [
      "https://www.oaklandca.gov/services/request-an-administrative-hearing",
    ],
  },
};
const fixed = {
  ...live,
  output: {
    ...live.output,
    checklist: [
      "Challenge the ticket within 21 days of its issue date. Check with the City of Oakland whether there is a filing fee.",
      "To ask for a hearing in person, go to 270 Frank H. Ogawa Plaza, Oakland, CA 94612, or call (800) 500-6484.",
    ],
  },
};

describe("grading a draft", () => {
  test("a cut-off step and talk of 'the notes' fail; the rest passes", () => {
    const { checks, detail } = gradeDraft(live, oakland.notes, {
      letter: true,
      maxQuestions: 5,
      asks: ["citation", "reason|why", "phone"],
    });
    expect(checks).toEqual({
      asks: false,
      complete: false,
      noLeak: false,
      plain: true,
      grounded: true,
      noHomework: true,
      sources: true,
      letter: true,
      fewQuestions: true,
    });
    expect(detail).toMatch(/cut off.*Hearing,/);
    expect(detail).toMatch(/leak/);
    expect(detail).toMatch(/never asks: phone$/);
    expect(passes(checks)).toBe(false);
  });

  test("the same draft with those fixed passes", () => {
    expect(
      passes(gradeDraft(fixed, oakland.notes, { letter: true }).checks),
    ).toBe(true);
  });

  test("a number the notes don't have is invented", () => {
    const invented = {
      ...fixed,
      output: {
        ...fixed.output,
        checklist: ["Pay the $75 fee within 30 days."],
      },
    };
    const { checks, detail } = gradeDraft(invented, oakland.notes);
    expect(checks.grounded).toBe(false);
    expect(detail).toBe("not in the notes: 75, 30");
  });

  test("markdown, homework questions and a missing letter are caught", () => {
    const { checks } = gradeDraft(
      {
        ...fixed,
        inputQuestions: [
          { key: "a", question: "What do the official instructions require?" },
        ],
        output: { title: "x", checklist: ["1. **Online:** renew online."] },
      },
      oakland.notes,
      { letter: true, maxQuestions: 0 },
    );
    expect(checks).toMatchObject({
      plain: false,
      noHomework: false,
      letter: false,
      fewQuestions: false,
      // Notes were given, and the draft names no page.
      sources: false,
    });
  });
});

test("intake: a clear request gets a goal, anything else one question", () => {
  const asks = { reply: "What do you need help with?", goal: null };
  expect(passes(gradeIntake("ask", asks).checks)).toBe(true);
  expect(gradeIntake("goal", asks).checks.goal).toBe(false);
  expect(
    gradeIntake("ask", { reply: "Which state? Which agency?", goal: null })
      .checks.oneQuestion,
  ).toBe(false);
  expect(
    passes(
      gradeIntake("goal", { reply: "Got it.", goal: "Renew a license." })
        .checks,
    ),
  ).toBe(true);
});

test("request: kind and place decide; the form is advisory", () => {
  const grade = (request: Parameters<typeof gradeRequest>[1]) =>
    gradeRequest(
      { kinds: ["process"], jurisdictions: ["us"], forms: ["IRS-8822"] },
      request,
      parseJurisdiction,
      normalizeFormId,
    ).checks;
  expect(
    grade({ kind: "process", jurisdiction: "US", forms: ["irs 8822"] }),
  ).toEqual({ kind: true, jurisdiction: true, "~forms": true });
  const noForm = grade({ kind: "process", jurisdiction: "us" });
  expect(noForm["~forms"]).toBe(false);
  expect(passes(noForm)).toBe(true);
  expect(passes(grade({ kind: "referral", jurisdiction: "us/ca" }))).toBe(
    false,
  );
});

test("research: sources must be on the authority's domain, with the facts", () => {
  const expected = { domain: "oaklandca.gov", facts: ["21"] };
  expect(passes(gradeResearch(expected, oakland.notes).checks)).toBe(true);
  expect(
    gradeResearch(expected, "Within 21 days. See https://www.nolo.com/parking")
      .checks,
  ).toEqual({ sources: true, onDomain: false, facts: true });
  expect(gradeResearch(expected, "No pages found.").checks).toMatchObject({
    sources: false,
  });
});

test("prefill: everything said is found, and nothing unsaid is guessed", () => {
  const expected = {
    has: { newAddress: "2 New Street" },
    absent: ["fullName"],
  };
  expect(
    passes(
      gradePrefill(expected, { newAddress: "2 New Street, Berkeley" }).checks,
    ),
  ).toBe(true);
  expect(gradePrefill(expected, {})).toEqual({
    checks: { found: false, noGuess: true },
    detail: "missed: newAddress=(none)",
  });
  expect(
    gradePrefill(expected, { newAddress: "2 New Street", fullName: "Ada" }),
  ).toEqual({
    checks: { found: true, noGuess: false },
    detail: "guessed: fullName=Ada",
  });
});
