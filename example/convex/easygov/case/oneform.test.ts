// One form is one entry, however research names it.
import { describe, expect, test } from "vitest";
import { onePerForm } from "./draft";
import { bareResearch, codeIn, sameForm, tidy } from "./research";

const form = (code: string, pdfUrl = "") => ({ code, pdfUrl, requiredBy: "" });

describe("sameForm", () => {
  test.each([
    ["VA Form 21-526EZ", "VA-FORM-21-526EZ"],
    ["VA Form 21-526EZ", "VA-21-526EZ"],
    ["IRS-8822", "Form 8822"],
    ["Request for Reconsideration", "request for reconsideration"],
  ])("%s is %s", (a, b) => expect(sameForm(form(a), form(b))).toBe(true));

  test("a title and a code are one form when they are one PDF", () => {
    const pdf = "https://www.ssa.gov/forms/ssa-561.pdf";
    expect(
      sameForm(form("Request for Reconsideration", pdf), form("SSA-561", pdf)),
    ).toBe(true);
  });

  test.each([
    ["IRS-8822", "IRS-8822-B"],
    ["DWC-1", "RCI-1"],
    ["Application", "Renewal notice"],
  ])("%s is not %s", (a, b) => expect(sameForm(form(a), form(b))).toBe(false));

  test("research that lists a form under two spellings reports it once", () => {
    const found = tidy({
      ...bareResearch("Apply."),
      forms: [form("VA Form 21-526EZ"), form("VA-21-526EZ")],
    });
    expect(found.forms.map(({ code }) => code)).toEqual(["VA Form 21-526EZ"]);
  });
});

describe("onePerForm", () => {
  const mail = { key: "filingMethod", equals: "mail" };
  const office = { key: "filingMethod", equals: "in_person" };
  const sameFile = (a: { file: string }, b: { file: string }) =>
    a.file === b.file;

  test("a title and a code for one file are one entry, under the code", () => {
    expect(
      onePerForm(
        [
          { code: "Request for Reconsideration", file: "a" },
          { code: "SSA-561", file: "a" },
          { code: "SSA-827", file: "b" },
        ],
        sameFile,
      ).map(({ code }) => code),
    ).toEqual(["SSA-561", "SSA-827"]);
  });

  test("needed whichever way wins over needed one way", () => {
    expect(
      onePerForm(
        [
          { code: "DL 44", file: "a", when: mail },
          { code: "DL 44", file: "a" },
        ],
        sameFile,
      ),
    ).toEqual([{ code: "DL 44", file: "a" }]);
    // Even when only the title was listed for everyone.
    expect(
      onePerForm(
        [
          { code: "DL 44", file: "a", when: mail },
          { code: "Application", file: "a" },
        ],
        sameFile,
      ),
    ).toEqual([{ code: "DL 44", file: "a", when: undefined }]);
  });

  test("a form two ways need, and not all, is listed once for each", () => {
    expect(
      onePerForm(
        [
          { code: "DL 44", file: "a", when: mail },
          { code: "DL-44", file: "a", when: office },
          { code: "DL 44", file: "a", when: mail },
        ],
        sameFile,
      ).map(({ when }) => when?.equals),
    ).toEqual(["mail", "in_person"]);
  });
});

test("a code written as two spellings is the first of them", () => {
  expect(codeIn("SSA-3441-BK / SSA-3441")).toBe("SSA-3441-BK");
  // A slash inside a code is part of it.
  expect(codeIn("DE 1/2 Claim")).toBe("DE 1/2 Claim");
});
