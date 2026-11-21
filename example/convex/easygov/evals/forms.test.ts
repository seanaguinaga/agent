import { describe, expect, test } from "vitest";
import { isOfficialHost } from "../forms/sources";
import { forms } from "./cases";
import { gradeForms, passes } from "./grading";
import { references } from "./references";
import { sameFormCode } from "../forms/sources";

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

  test.each(Object.entries(references))(
    "%s: the reference answer and the case expect the same files",
    (id, reference) => {
      const c = forms.find((each) => each.id === id);
      expect(c).toBeDefined();
      for (const { code, url } of c!.expect) {
        const named = reference.forms.find((form) =>
          sameFormCode(form.code, code),
        );
        // Every form the case expects is in the reference, at the same file.
        expect(named?.file).toBe(url);
      }
    },
  );

  test.each(forms)("$id: the goal doesn't name a form it expects", (c) => {
    for (const { code } of c.expect) {
      const number = code.replace(/^[A-Z]+-(?=.*\d)/, "");
      expect(c.goal.toUpperCase()).not.toContain(number.toUpperCase());
    }
  });
});

describe("gradeForms", () => {
  const expected = [{ code: "SSA-561-U2" }, { code: "SSA-827" }];

  test("a translation of the published edition is the wrong file", () => {
    const edition = { revision: 202508, places: 40, pages: 4 };
    const graded = gradeForms(
      [{ code: "SSA-561" }],
      [
        {
          code: "SSA-561",
          url: "https://www.ssa.gov/forms/ssa-561-sp.pdf",
          editionId: "es",
          facts: { ...edition, language: "es" },
          backed: true,
        },
      ],
      [
        {
          code: "SSA-561",
          editionId: "en",
          facts: { ...edition, language: "en" },
        },
      ],
    );
    expect(graded.forms).toMatchObject([{ outcome: "wrongUnwarned" }]);
  });

  test("a form listed for two ways of filing is graded by the worse file", () => {
    const graded = gradeForms(
      [{ code: "SSA-561" }],
      [
        {
          code: "SSA-561",
          url: "https://a.gov/wrong.pdf",
          editionId: "x",
          backed: true,
        },
        {
          code: "SSA-561",
          url: "https://a.gov/right.pdf",
          editionId: "en",
          backed: true,
        },
      ],
      [{ code: "SSA-561", editionId: "en" }],
    );
    expect(graded.forms).toMatchObject([
      { outcome: "wrongUnwarned", file: "x" },
    ]);
    expect(graded.checks.warnedIfWrong).toBe(false);
  });

  test("passes when every expected form is named and fetched as the published file", () => {
    const graded = gradeForms(
      expected,
      [
        {
          code: "SSA-561-U2",
          url: "https://www.ssa.gov/forms/ssa-561-u2.pdf",
          editionId: "a",
        },
        {
          code: "Form SSA-827",
          url: "https://www.ssa.gov/forms/ssa-827.pdf",
          editionId: "b",
        },
        { code: "SSA-3373", url: "https://www.ssa.gov/forms/ssa-3373.pdf" },
      ],
      [
        { code: "SSA-561-U2", editionId: "a" },
        { code: "SSA-827", editionId: "b" },
      ],
    );
    expect(graded.checks).toEqual({
      named: true,
      located: true,
      verified: true,
      warnedIfWrong: true,
      "~sameEdition": true,
      "~backed": false,
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

  test("says what the person ends up holding for each form", () => {
    const published = [
      { code: "A-100", editionId: "a" },
      { code: "B-200", editionId: "b" },
      { code: "C-300", editionId: "c" },
      { code: "D-400", editionId: "d" },
      { code: "E-500", editionId: "e" },
      // The case's own address gave no file for this one.
      { code: "F-600" },
    ];
    const at = (code: string, editionId: string, backed: boolean) => ({
      code,
      url: `https://www.ssa.gov/${code}.pdf`,
      editionId,
      backed,
    });
    const graded = gradeForms(
      published,
      [
        at("A-100", "a", true),
        at("B-200", "b", false),
        at("C-300", "old", false),
        at("D-400", "old", true),
        { code: "E-500" },
        at("F-600", "f", true),
      ],
      published,
    );
    expect(graded.forms.map(({ outcome }) => outcome)).toEqual([
      "rightBacked",
      "rightWarned",
      "wrongWarned",
      "wrongUnwarned",
      "missing",
      "unverified",
    ]);
    expect(graded.forms[0].file).toBe("a");
    // Only the wrong file handed over as the authority's own, and the form
    // that never came, fail the trial: the rest the person was told about.
    expect(graded.checks).toMatchObject({
      located: false,
      warnedIfWrong: false,
      "~sameEdition": false,
      "~backed": false,
    });
    expect(graded.detail).toBe(
      "not located: E-500; not verified: F-600; other edition: C-300; other edition, no warning: D-400",
    );
    // A file with nothing published to compare it with proves nothing.
    expect(graded.checks.verified).toBe(false);
    expect(
      passes(
        gradeForms(
          published.slice(0, 3),
          [
            at("A-100", "a", true),
            at("B-200", "b", false),
            at("C-300", "old", false),
          ],
          published,
        ).checks,
      ),
    ).toBe(true);
  });
});
