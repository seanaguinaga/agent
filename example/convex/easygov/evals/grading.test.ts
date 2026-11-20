// The graders, against a real draft that had the defects they look for.
import { describe, expect, test } from "vitest";
import { normalizeFormId, parseJurisdiction } from "../packs/schema";
import { draft as draftCases } from "./cases";
import {
  gradeAddress,
  gradeDraft,
  gradeIntake,
  gradeMapping,
  gradePipeline,
  gradeSuggest,
  gradeRequest,
  gradeResearch,
  gradeTailor,
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

test("suggest: everything said is found, and nothing unsaid is guessed", () => {
  const expected = {
    has: { newAddress: "2 New Street" },
    absent: ["fullName"],
  };
  expect(
    passes(
      gradeSuggest(expected, { newAddress: "2 New Street, Berkeley" }).checks,
    ),
  ).toBe(true);
  expect(gradeSuggest(expected, {})).toEqual({
    checks: { found: false, noGuess: true },
    detail: "missed: newAddress=(none)",
  });
  expect(
    gradeSuggest(expected, { newAddress: "2 New Street", fullName: "Ada" }),
  ).toEqual({
    checks: { found: true, noGuess: false },
    detail: "guessed: fullName=Ada",
  });
});

test("tailoring: steps that apply stay, steps ruled out go", () => {
  const expected = { keep: [1, 2, 6], drop: [3, 4] };
  expect(passes(gradeTailor(expected, [1, 2, 5, 6]).checks)).toBe(true);
  expect(gradeTailor(expected, [1, 3, 6])).toEqual({
    checks: { keeps: false, drops: false },
    detail: "lost: 2; should have dropped: 3",
  });
});

test("address: each part exact, and nothing the text didn't give", () => {
  const expected = {
    parts: { street: "270 Frank H. Ogawa Plaza", city: "Oakland", state: "CA" },
    blank: ["postalCode"] as const,
  };
  const got = {
    street: "270 Frank H. Ogawa Plaza",
    city: "oakland",
    state: "CA",
    postalCode: "",
    country: "US",
  };
  expect(passes(gradeAddress(expected, got).checks)).toBe(true);
  expect(gradeAddress(expected, { ...got, postalCode: "94612" })).toMatchObject(
    {
      checks: { noGuess: false },
      detail: "made up: postalCode=94612",
    },
  );
  expect(gradeAddress({ parts: null }, got).checks).toEqual({
    recognized: false,
  });
  expect(passes(gradeAddress({ parts: null }, null).checks)).toBe(true);
});

test("a draft reads the person's name and address from the profile's keys", () => {
  const letter =
    "From {{fullName}}, {{mailingAddress}}. Citation {{citation}}.";
  const draft = {
    ...fixed,
    inputs: ["fullName", "mailingAddress", "citation"],
    inputQuestions: [
      { key: "fullName", question: "Full legal name" },
      { key: "mailingAddress", question: "Mailing address" },
      { key: "citation", question: "What is your citation number?" },
    ],
    output: { ...fixed.output, letter },
  };
  expect(
    gradeDraft(draft, oakland.notes, { usesProfile: true }).checks.usesProfile,
  ).toBe(true);
  const asksAgain = {
    ...draft,
    inputQuestions: [
      ...draft.inputQuestions,
      { key: "telephone", question: "What is your telephone number?" },
    ],
  };
  const graded = gradeDraft(asksAgain, oakland.notes, { usesProfile: true });
  expect(graded.checks.usesProfile).toBe(false);
  expect(graded.detail).toMatch(/asks again: telephone/);
});

test("mapping: the right key for the filer, nothing typed where the person signs", () => {
  const expected = {
    name: { readings: ["fullName"] },
    initial: { readings: ["middleInitial"] },
    ssn: { left: true as const },
    spouse: { notProfile: true as const },
    newAddress: { caseInput: true as const },
    individual: { group: "returns", many: true },
    gift: { group: "returns", many: true },
  };
  const good = [
    { target: "name", input: "fullName" },
    { target: "initial", input: "middleInitial" },
    {
      target: "ssn",
      leave: { why: "confidential" as const, note: "Your SSN." },
    },
    { target: "newAddress", input: "newAddress" },
    { target: "individual", input: "returns", includes: "individual" },
    { target: "gift", input: "returns", includes: "gift" },
  ];
  expect(passes(gradeMapping(expected, good).checks)).toBe(true);
  // The mistakes that matter: a whole name in an initial's box, the filer's
  // name in the spouse's box, an ID number asked for, a profile key for
  // something the profile doesn't hold, one question split in two.
  expect(
    gradeMapping(expected, [
      { target: "name", input: "fullName" },
      { target: "initial", input: "middleName" },
      { target: "ssn", input: "ssn" },
      { target: "spouse", input: "fullName" },
      { target: "newAddress", input: "homeAddressLine" },
      { target: "individual", input: "individualReturns", includes: "yes" },
      { target: "gift", input: "giftReturns", includes: "yes" },
    ]),
  ).toEqual({
    checks: {
      profile: false,
      caseInputs: false,
      left: false,
      notOthers: false,
      groups: false,
    },
    detail:
      "profile: initial=middleName; caseInputs: newAddress=homeAddressLine; left: ssn=ssn; others: spouse=fullName; groups: returns: split across individualReturns, giftReturns",
  });
});

test("a case on a real form is graded on what the PDF itself holds", () => {
  const expected = {
    form: { inputs: ["fullName", "newAddress"], ticked: 1, toComplete: 2 },
  };
  const c = {
    status: "done",
    answers: { fullName: "Ada Lovelace", newAddress: "2 New Street" },
    accepted: { fingerprint: "f" },
    artifact: {
      fingerprint: "f",
      document: {
        omissions: [],
        toComplete: [
          { why: "confidential", note: "SSN" },
          { why: "signature", note: "Sign" },
        ],
      },
    },
  } as unknown as Parameters<typeof gradePipeline>[1];
  const onForm = { texts: ["Ada Lovelace", "2 New Street"], ticked: 1 };
  expect(passes(gradePipeline(expected, c, onForm).checks)).toBe(true);
  // The case says it wrote the address; the PDF doesn't have it.
  const graded = gradePipeline(expected, c, {
    texts: ["Ada Lovelace"],
    ticked: 2,
  });
  expect(graded.checks).toMatchObject({ written: false, ticked: false });
  expect(graded.detail).toMatch(/not on the PDF: newAddress; 2 ticked/);
  // No PDF to read at all.
  expect(gradePipeline(expected, c).checks).toMatchObject({
    document: false,
    written: false,
  });
});
