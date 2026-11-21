import { describe, expect, test } from "vitest";
import { isOfficialHost } from "../forms/sources";
import { forms } from "./cases";
import { gradeForms, passes, sameCode } from "./grading";

describe("the forms cases", () => {
  const expected = forms.flatMap(({ id, expect }) =>
    expect.map((form) => ({ id, ...form })),
  );

  test("each has its own id", () => {
    expect(new Set(forms.map(({ id }) => id)).size).toBe(forms.length);
  });

  test.each(expected)(
    "$id: $code is published on an official host",
    ({ url }) => expect(isOfficialHost(url)).toBe(true),
  );

  test.each(forms)("$id: the goal doesn't name a form it expects", (c) => {
    for (const { code } of c.expect) {
      const number = code.replace(/^[A-Z]+-(?=.*\d)/, "");
      expect(c.goal.toUpperCase()).not.toContain(number.toUpperCase());
    }
  });
});

describe("sameCode", () => {
  test.each([
    ["IRS-FORM-12153", "Form 12153"],
    ["SSA-3441-BK", "SSA-3441"],
    ["DWC-1", "DWC Form 1"],
    ["USCIS-I-864", "I-864"],
    ["DL-410-FO", "DL 410 FO"],
    ["VA-21-526EZ", "VA Form 21-526EZ"],
  ])("%s is %s", (a, b) => expect(sameCode(a, b)).toBe(true));

  test.each([
    ["DLSE-FORM-1", "Form 1"],
    ["SUM-100", "CM-010"],
    ["DL-410-FO", "DL 410 ID"],
  ])("%s is not %s", (a, b) => expect(sameCode(a, b)).toBe(false));
});

describe("gradeForms", () => {
  const expected = [{ code: "SSA-561-U2" }, { code: "SSA-827" }];

  test("passes when every expected form is named and fetched", () => {
    const graded = gradeForms(expected, [
      { code: "SSA-561-U2", url: "https://www.ssa.gov/forms/ssa-561-u2.pdf" },
      { code: "Form SSA-827", url: "https://www.ssa.gov/forms/ssa-827.pdf" },
      { code: "SSA-3373", url: "https://www.ssa.gov/forms/ssa-3373.pdf" },
    ]);
    expect(graded.checks).toEqual({
      named: true,
      located: true,
      "~sameEdition": true,
      "~noExtras": false,
    });
    // A form beyond the list is recorded, and isn't a failure.
    expect(passes(graded.checks)).toBe(true);
    expect(graded.detail).toBe("extra: SSA-3373");
  });

  test("tells a form that was missed from one that couldn't be fetched", () => {
    const graded = gradeForms(expected, [{ code: "SSA-827" }]);
    expect(graded.checks).toMatchObject({ named: false, located: false });
    expect(graded.detail).toBe("missing: SSA-561-U2; not located: SSA-827");
  });

  test("notes a located form whose file isn't the published one", () => {
    const found = [
      { code: "SSA-561-U2", url: "https://www.ssa.gov/a.pdf", editionId: "e1" },
      { code: "SSA-827", url: "https://www.ssa.gov/b.pdf", editionId: "e2" },
    ];
    const graded = gradeForms(expected, found, [
      { code: "SSA-561-U2", editionId: "e1" },
      { code: "SSA-827", editionId: "other" },
    ]);
    expect(graded.checks["~sameEdition"]).toBe(false);
    expect(graded.detail).toBe("other edition: SSA-827");
    // The same edition from another address isn't a different edition.
    const edition = { revision: 202207, places: 65, pages: 3 };
    expect(
      gradeForms(
        [{ code: "SSA-827" }],
        [
          {
            code: "SSA-827",
            url: "https://x.gov/b.pdf",
            editionId: "e2",
            facts: edition,
          },
        ],
        [{ code: "SSA-827", editionId: "other", facts: edition }],
      ).checks["~sameEdition"],
    ).toBe(true);
    // A form named only by its title is found by its file.
    const byTitle = gradeForms(
      [{ code: "DL-410-FO" }],
      [
        {
          code: "Renewal by Mail Eligibility Information",
          url: "https://x.gov/dl.pdf",
          editionId: "e9",
          facts: edition,
        },
      ],
      [{ code: "DL-410-FO", editionId: "e9", facts: edition }],
    );
    expect(byTitle.checks).toMatchObject({ named: true, located: true });
    expect(byTitle.checks["~noExtras"]).toBe(true);
    // It is recorded, and doesn't fail the trial by itself.
    expect(passes(graded.checks)).toBe(true);
  });
});
