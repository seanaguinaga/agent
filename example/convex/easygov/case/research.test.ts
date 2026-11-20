// The research as data, and the notes kept of it.
import { describe, expect, test } from "vitest";
import { citedFormPdfs, citedIn } from "./draft";
import {
  codeIn,
  formLeads,
  isIdentified,
  methodNamed,
  notesOf,
  pagesOf,
  tidy,
  withMethodForms,
  type Research,
} from "./research";

const PAGE = "https://example.gov/appeals";
const PDF = "https://example.gov/forms/ab123.pdf";
const form = (code: string, pdfUrl = "", requiredBy = PAGE) => ({
  code,
  pdfUrl,
  requiredBy,
});
const way = (
  method: Research["methods"][number]["method"],
  forms: Research["forms"] = [],
  rest: Partial<Research["methods"][number]> = {},
) => ({ method, eligibility: "", forms, portalUrl: "", ...rest });

describe("tidy", () => {
  test("lists each way and each form once, and keeps only full https pages", () => {
    const found = tidy({
      findings: " Renew online or by mail. ",
      methods: [
        way("mail", [form("AB-123", PDF), form("ab 123", PDF)]),
        way("online", [], { portalUrl: "example.gov/portal" }),
        way("mail", [form("Payment"), form("")], {
          eligibility: "If notified.",
        }),
      ],
      forms: [form("ZZ 9", "not found", "the office")],
      sources: ["dmv.ca.gov", "http://example.gov/x", ` ${PAGE} `, PAGE],
    });
    expect(found).toEqual({
      findings: "Renew online or by mail.",
      methods: [
        way("online"),
        way("mail", [form("AB-123", PDF), form("Payment")], {
          eligibility: "If notified.",
        }),
      ],
      forms: [form("ZZ 9", "", "")],
      sources: [PAGE],
    });
  });

  test("a form every way needs is needed whichever way", () => {
    const found = tidy({
      findings: "Appeal.",
      methods: [
        way("mail", [form("AB-123", PDF), form("AB-410")]),
        way("in_person", [form("AB 123")]),
      ],
      forms: [],
      sources: [],
    });
    expect(found.forms).toEqual([form("AB-123", PDF)]);
    expect(formLeads(found)).toEqual([
      form("AB-123", PDF),
      { ...form("AB-410"), method: "mail" },
    ]);
  });
});

test("a page given as a form's PDF is where the form is asked for, not its PDF", () => {
  const [contest, viaFile] = tidy({
    findings: "Contest it.",
    methods: [],
    forms: [
      { code: "Contest Form", pdfUrl: PAGE, requiredBy: "" },
      form("OL 45", "https://example.gov/portal/file/renewal-ol-45-pdf/"),
    ],
    sources: [],
  }).forms;
  expect(contest).toEqual({
    code: "Contest Form",
    pdfUrl: "",
    requiredBy: PAGE,
  });
  expect(viaFile.pdfUrl).toBe(
    "https://example.gov/portal/file/renewal-ol-45-pdf/",
  );
  // A bare title with no PDF can't be told apart from another form.
  expect(isIdentified(contest)).toBe(false);
  expect(isIdentified(viaFile)).toBe(true);
  expect(isIdentified(form("DL 44"))).toBe(true);
  expect(isIdentified(form("Renewal notice"))).toBe(false);
});

describe("notesOf", () => {
  const found: Research = {
    findings: "Appeal within 60 days.",
    methods: [
      way("online", [], { portalUrl: "https://example.gov/portal" }),
      way("mail", [form("AB-123", PDF)], { eligibility: "If notified." }),
    ],
    forms: [form("Proof of Service")],
    sources: [PAGE],
  };

  test("writes the findings, each way, each form, then every page", () => {
    const notes = notesOf(found);
    expect(notes).toBe(
      [
        "Appeal within 60 days.",
        "Ways to file:",
        "- Online Portal: https://example.gov/portal",
        "- By mail: If notified.",
        "Forms:",
        `- Proof of Service: PDF not located, required by ${PAGE}`,
        `- AB-123 (by mail only): PDF ${PDF}, required by ${PAGE}`,
        `Pages: ${PAGE} https://example.gov/portal`,
      ].join("\n"),
    );
    // A form's PDF is cited, so a rule or a named form can rest on it,
    // but it isn't one of the pages the process was read from.
    expect(citedIn(notes)).toContain(PDF);
    expect(pagesOf(found)).not.toContain(PDF);
    expect(citedFormPdfs(["AB-123"], citedIn(notes))).toEqual([
      { code: "AB-123", sourceUrl: PDF },
    ]);
  });

  test("is empty when the search found nothing to say", () => {
    expect(notesOf({ ...found, findings: "  " })).toBe("");
  });
});

test("methodNamed reads a way of filing however it is worded", () => {
  expect(methodNamed("By Mail")).toBe("mail");
  expect(methodNamed("in-person")).toBe("in_person");
  expect(methodNamed("at a DMV office")).toBe("in_person");
  expect(methodNamed("Online")).toBe("online");
  expect(methodNamed("yes")).toBeUndefined();
});

test("codeIn keeps a form's code and drops its title", () => {
  expect(
    codeIn(
      "DL 410 FO, California Driver License Renewal by Mail Eligibility Information",
    ),
  ).toBe("DL 410 FO");
  expect(
    codeIn("Driver License or Identification Card Application (DL 44)"),
  ).toBe("DL 44");
  expect(codeIn("Form 8822: Change of Address")).toBe("Form 8822");
  expect(codeIn("IRS-8822")).toBe("IRS-8822");
  expect(codeIn("SS-5 - Application for a Social Security Card")).toBe("SS-5");
  // A bare title has no code to cut down to.
  expect(codeIn("Contest Form, City of Oakland")).toBe(
    "Contest Form, City of Oakland",
  );
});

test("a form one way was asked about belongs to that way, not to every way", () => {
  const found = withMethodForms(
    {
      findings: "Renew online, by mail or in person.",
      methods: [way("online"), way("mail"), way("in_person")],
      forms: [form("DL 44"), form("DL 410 FO")],
      sources: [PAGE],
    },
    [
      { method: "mail", forms: [form("DL 410 FO", PDF)] },
      { method: "in_person", forms: [] },
    ],
  );
  expect(formLeads(found)).toEqual([
    form("DL 44"),
    { ...form("DL 410 FO", PDF), method: "mail" },
  ]);
});
