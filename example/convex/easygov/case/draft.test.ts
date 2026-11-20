// How a model's draft becomes a process pack: what survives, and what is
// dropped because nothing reads it or no source backs it.
import { describe, expect, test } from "vitest";
import {
  checklistPack,
  researchedPack,
  zDraft,
  type Draft,
  type Subject,
} from "./draft";
import { bareResearch, type Research } from "./research";

const PAGE = "https://example.gov/appeals";
const PDF = "https://example.gov/forms/ab123.pdf";
// Research that is only its notes: no ways of filing or forms as data.
const NOTES = bareResearch(
  `Appeal within 60 days. See ${PAGE}. The form is at ${PDF}.`,
);
const MAIL_PDF = "https://example.gov/forms/ab-410.pdf";
/** Research that found three ways of filing, and a form only mail needs. */
const ROUTED: Research = {
  findings: "Appeal within 60 days, online, by mail or in person.",
  methods: [
    { method: "online", eligibility: "", forms: [], portalUrl: "" },
    {
      method: "mail",
      eligibility: "If your notice says you may.",
      forms: [{ code: "AB-410", pdfUrl: MAIL_PDF, requiredBy: PAGE }],
      portalUrl: "",
    },
    { method: "in_person", eligibility: "", forms: [], portalUrl: "" },
  ],
  forms: [{ code: "AB-9", pdfUrl: "", requiredBy: PAGE }],
  sources: [PAGE],
};

const subject: Subject = {
  process: "Appeal a benefits denial",
  jurisdiction: "us/ca",
  authority: "Example Agency",
  forms: ["AB-123"],
};

function draft(overrides: Partial<Draft> = {}): Draft {
  return {
    title: "Appeal a denial",
    description: "How to appeal.",
    aliases: ["benefits appeal"],
    inputQuestions: [],
    output: { title: "Your appeal", checklist: ["Gather the notice."] },
    ...overrides,
  };
}

const withLetter = (letter: string, rest: Partial<Draft> = {}) =>
  draft({
    ...rest,
    output: { title: "Your appeal", checklist: ["Send it."], letter },
  });

describe("checklistPack", () => {
  test("keeps the checklist and drops everything that needs research", () => {
    const pack = checklistPack(
      withLetter("I am {{fullName}}, writing about {{noticeDate}}.", {
        inputQuestions: [{ key: "noticeDate", question: "Notice date?" }],
        situationQuestions: [{ key: "route", question: "Online or mail?" }],
        evidence: [{ key: "notice", label: "The notice", required: true }],
        referralKind: "benefits lawyer",
        filingOrder: ["letter"],
      }),
      subject,
    );
    expect(pack).toEqual({
      title: "Appeal a denial",
      description: "How to appeal.",
      aliases: ["benefits appeal"],
      output: { title: "Your appeal", checklist: ["Send it."] },
      jurisdiction: "us/ca",
      authority: "Example Agency",
      forms: ["AB-123"],
      inputs: [],
      inputQuestions: [],
    });
  });
});

describe("researchedPack", () => {
  test("asks for each letter placeholder, and nothing else the model asked", () => {
    const pack = researchedPack(
      withLetter("I am {{fullName}}. The notice is dated {{noticeDate}}.", {
        inputQuestions: [
          { key: "noticeDate", question: "What date is on the notice?" },
          { key: "favoriteColor", question: "Favorite color?" },
        ],
      }),
      subject,
      NOTES,
    );
    expect(pack.inputs).toEqual(["fullName", "noticeDate"]);
    expect(pack.inputQuestions).toEqual([
      { key: "fullName", question: "Full legal name" },
      { key: "noticeDate", question: "What date is on the notice?" },
    ]);
    expect(pack.output?.sources).toEqual([PAGE, PDF]);
  });

  test("leaves confidential identifiers to be completed by hand", () => {
    const pack = researchedPack(
      withLetter("SSN: {{ssn}}. Reference: {{caseRef}}.", {
        inputQuestions: [
          { key: "ssn", question: "Your number?" },
          { key: "caseRef", question: "Your Social Security number?" },
        ],
      }),
      subject,
      NOTES,
    );
    expect(pack.output?.letter).toBe(
      "SSN: [complete by hand]. Reference: [complete by hand].",
    );
    expect(pack.inputs).toEqual([]);
  });

  test("keeps only rules and deadlines whose source the notes cite", () => {
    const rule = {
      condition: "Lives in the state",
      key: "isResident",
      question: "Do you live in California?",
      qualifiesWhen: "yes",
    };
    const deadline = {
      label: "Appeal by",
      fromInput: "noticeDate",
      question: "What date is on the notice?",
      days: 60,
    };
    const cited = researchedPack(
      draft({
        inputQuestions: [{ key: "isResident", question: "Resident?" }],
        eligibility: [{ ...rule, sourceUrl: PAGE }],
        deadline: { ...deadline, sourceUrl: PAGE },
      }),
      subject,
      NOTES,
    );
    // The rule is stored without its question, which moves to inputQuestions.
    expect(cited.eligibility).toEqual([
      {
        condition: "Lives in the state",
        key: "isResident",
        qualifiesWhen: "yes",
        sourceUrl: PAGE,
      },
    ]);
    expect(cited.deadline).toEqual({
      label: "Appeal by",
      fromInput: "noticeDate",
      days: 60,
    });
    expect(cited.inputs).toEqual(["isResident", "noticeDate"]);
    // The rule's own question wins over the model's, with fixed choices.
    expect(cited.inputQuestions).toEqual([
      {
        key: "isResident",
        question: "Do you live in California?",
        choices: [
          { value: "yes", label: "yes" },
          { value: "no", label: "no" },
          { value: "unknown", label: "Unsure" },
        ],
      },
      { key: "noticeDate", question: "What date is on the notice?" },
    ]);

    const uncited = researchedPack(
      draft({
        eligibility: [{ ...rule, sourceUrl: "https://elsewhere.example" }],
        deadline: { ...deadline, sourceUrl: "https://elsewhere.example" },
      }),
      subject,
      NOTES,
    );
    expect(uncited.eligibility).toBeUndefined();
    expect(uncited.deadline).toBeUndefined();
    expect(uncited.inputs).toEqual([]);
  });

  test("counts a page as cited however far down the notes it is named", () => {
    const pages = Array.from(
      { length: 12 },
      (_, i) => `https://example.gov/p${i}`,
    );
    const pack = researchedPack(
      draft({
        eligibility: [
          {
            condition: "Lives in the state",
            key: "isResident",
            question: "Do you live in California?",
            qualifiesWhen: "yes",
            sourceUrl: pages[11],
          },
        ],
      }),
      subject,
      bareResearch(`See ${pages.join(" and ")}.`),
    );
    expect(pack.eligibility?.[0].sourceUrl).toBe(pages[11]);
    // The draft still lists only its first few sources.
    expect(pack.output?.sources).toEqual(pages.slice(0, 8));
  });

  test("tailors by situation questions the letter doesn't already read", () => {
    const pack = researchedPack(
      withLetter("I will file {{route}}.", {
        situationQuestions: [
          { key: "route", question: "Online or mail?" },
          {
            key: "over65",
            question: "Are you 65 or older?",
            choices: ["yes", "no"],
          },
        ],
      }),
      subject,
      NOTES,
    );
    expect(pack.output?.tailorBy).toEqual(["over65"]);
    expect(pack.inputs).toEqual(["route", "over65"]);
    expect(pack.inputQuestions?.[1]).toEqual({
      key: "over65",
      question: "Are you 65 or older?",
      choices: [
        { value: "yes", label: "yes" },
        { value: "no", label: "no" },
      ],
    });
  });

  test("adds the cited PDF of a form the person named", () => {
    expect(researchedPack(draft(), subject, NOTES).packetForms).toEqual([
      {
        code: "AB-123",
        sourceUrl: PDF,
        inputs: [],
        openItem:
          "Locate and complete AB-123 using the authority’s instructions.",
      },
    ]);
  });

  test("a letter that is one route among several keeps its inputs on the route", () => {
    const pack = researchedPack(
      withLetter("I am {{fullName}}.", {
        letterWhen: { key: "route", equals: "mail" },
        situationQuestions: [
          {
            key: "route",
            question: "Online or mail?",
            choices: ["online", "mail"],
          },
        ],
      }),
      subject,
      NOTES,
    );
    expect(pack.letterRoute).toEqual({
      key: "route",
      equals: "mail",
      inputs: ["fullName"],
    });
    expect(pack.inputs).toEqual(["route"]);
    expect(pack.inputQuestions?.map((q) => q.key)).toEqual([
      "route",
      "fullName",
    ]);
  });

  test("refuses a route the draft never asks about", () => {
    const build = () =>
      researchedPack(
        draft({
          evidence: [
            {
              key: "idCopy",
              label: "Copy of ID",
              required: true,
              when: { key: "route", equals: "mail" },
            },
          ],
        }),
        subject,
        NOTES,
      );
    expect(build).toThrow('routes by "route" but asks no question');
  });

  test("offers every answer a route depends on", () => {
    const pack = researchedPack(
      withLetter("I am {{fullName}}.", {
        letterWhen: { key: "route", equals: "MAIL" },
        situationQuestions: [
          {
            key: "route",
            question: "Online or mail?",
            choices: ["online", "mail"],
          },
        ],
        evidence: [
          {
            key: "idCopy",
            label: "Copy of ID",
            required: true,
            when: { key: "route", equals: "in person" },
          },
        ],
      }),
      subject,
      NOTES,
    );
    expect(pack.inputQuestions?.[0].choices?.map((c) => c.value)).toEqual([
      "online",
      "mail",
      "in person",
    ]);
  });
});

describe("researchedPack, with ways of filing", () => {
  const none = { ...subject, forms: [] };
  const filing = {
    key: "filingMethod",
    question: "How do you want to do this: online, by mail or in person?",
    choices: [
      { value: "online", label: "Online" },
      { value: "mail", label: "By mail" },
      { value: "in_person", label: "In person" },
    ],
  };

  test("asks which way, and routes each form to the way that needs it", () => {
    // The model lists no forms and asks nothing: both come from research.
    const pack = researchedPack(draft(), none, ROUTED);
    expect(pack.inputs).toEqual(["filingMethod"]);
    expect(pack.inputQuestions).toEqual([filing]);
    expect(pack.output?.tailorBy).toEqual(["filingMethod"]);
    expect(pack.packetForms).toEqual([
      {
        code: "AB-9",
        sourceUrl: "",
        inputs: [],
        openItem:
          "Locate and complete AB-9 using the authority’s instructions.",
      },
      {
        code: "AB-410",
        sourceUrl: MAIL_PDF,
        inputs: [],
        when: { key: "filingMethod", equals: "mail" },
        openItem:
          "Locate and complete AB-410 using the authority’s instructions.",
      },
    ]);
    // A form's PDF is a lead, not a page the process was read from.
    expect(pack.output?.sources).toEqual([PAGE]);
  });

  test("drops the model's own question about the way of filing", () => {
    const pack = researchedPack(
      draft({
        situationQuestions: [
          { key: "filingMethod", question: "Mail or web?", choices: ["web"] },
          { key: "over70", question: "Are you 70 or older?" },
        ],
      }),
      none,
      ROUTED,
    );
    expect(pack.inputQuestions).toEqual([
      filing,
      { key: "over70", question: "Are you 70 or older?" },
    ]);
  });

  test("spells a route by the way of filing as one of the ways found", () => {
    const pack = researchedPack(
      withLetter("I am {{fullName}}.", {
        letterWhen: { key: "filingMethod", equals: "By Mail" },
        evidence: [
          {
            key: "idCopy",
            label: "Copy of ID",
            required: true,
            when: { key: "filingMethod", equals: "in person" },
          },
        ],
      }),
      none,
      ROUTED,
    );
    expect(pack.letterRoute).toEqual({
      key: "filingMethod",
      equals: "mail",
      inputs: ["fullName"],
    });
    expect(pack.evidence?.[0].when).toEqual({
      key: "filingMethod",
      equals: "in_person",
    });
    expect(pack.inputQuestions?.[0]).toEqual(filing);
  });

  test("refuses a route by a way of filing the research didn't find", () => {
    const twoWays = { ...ROUTED, methods: ROUTED.methods.slice(0, 2) };
    const build = () =>
      researchedPack(
        withLetter("Hello.", {
          letterWhen: { key: "filingMethod", equals: "in person" },
        }),
        none,
        twoWays,
      );
    expect(build).toThrow("a way of filing the research didn't find");
  });

  test("leaves a form known only by a title out of the packet", () => {
    const pack = researchedPack(draft(), none, {
      ...ROUTED,
      forms: [
        { code: "Renewal notice", pdfUrl: "", requiredBy: PAGE },
        { code: "Application", pdfUrl: "", requiredBy: PAGE },
      ],
    });
    expect(pack.packetForms?.map((f) => f.code)).toEqual(["AB-410"]);
  });

  test("asks nothing when there is only one way", () => {
    const pack = researchedPack(draft(), none, {
      ...ROUTED,
      methods: ROUTED.methods.slice(1, 2),
    });
    expect(pack.inputs).toEqual([]);
    expect(pack.packetForms?.map(({ code, when }) => [code, when])).toEqual([
      ["AB-9", undefined],
      ["AB-410", undefined],
    ]);
  });
});

describe("zDraft", () => {
  test("rejects a key that names a built-in property", () => {
    const routed = (key: string) =>
      zDraft.safeParse(draft({ letterWhen: { key, equals: "mail" } })).success;
    expect(routed("route")).toBe(true);
    expect(routed("constructor")).toBe(false);
    expect(
      zDraft.safeParse(
        draft({ inputQuestions: [{ key: "toString", question: "Why?" }] }),
      ).success,
    ).toBe(false);
  });
});
