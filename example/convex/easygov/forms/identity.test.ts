// What counts as one address, one page link and one form, and when a
// failure is left alone.
import { describe, expect, test } from "vitest";
import { revisionOf } from "./facts";
import {
  addressKey,
  bareCode,
  carriesNumber,
  isTheForm,
  stands,
  isWebPage,
  labelledLinks,
  looseKey,
  sameAddress,
} from "./sources";

describe("an address", () => {
  test("is one place whatever its host's case or fragment", () => {
    expect(
      sameAddress(
        "https://WWW.VBA.VA.gov/pubs/forms/VBA-21-526EZ-ARE.pdf#page=2",
        "https://www.vba.va.gov/pubs/forms/VBA-21-526EZ-ARE.pdf",
      ),
    ).toBe(true);
  });

  test("keeps its path as written: a server may tell files apart by case", () => {
    const [a, b] = [
      "https://www.dir.ca.gov/dwc/DWCForm1.pdf",
      "https://www.dir.ca.gov/dwc/dwcform1.pdf",
    ];
    expect(sameAddress(a, b)).toBe(false);
    // They are still probably one place: the second waits on the first.
    expect(looseKey(a)).toBe(looseKey(b));
  });

  test("keeps its query: one handler serves many files", () => {
    expect(
      addressKey("https://www.reginfo.gov/do/Download?objectID=1"),
    ).not.toBe(addressKey("https://www.reginfo.gov/do/Download?objectID=2"));
  });
});

describe("what an address answered", () => {
  const HOUR = 3_600_000;
  test("a failure stands for an hour, then twice as long each time, up to a week", () => {
    const at = (failures: number, age: number) =>
      stands({ outcome: "gone", checkedAt: 0, failures }, age);
    expect(at(1, HOUR - 1)).toBe(true);
    expect(at(1, HOUR)).toBe(false);
    expect(at(3, 4 * HOUR - 1)).toBe(true);
    expect(at(3, 4 * HOUR)).toBe(false);
    expect(at(30, 7 * 24 * HOUR - 1)).toBe(true);
    expect(at(30, 7 * 24 * HOUR)).toBe(false);
  });

  test("a page's links stand for a day; a file never stands on its age", () => {
    const page = { outcome: "page", checkedAt: 0, failures: 0 };
    expect(stands(page, 24 * HOUR - 1)).toBe(true);
    expect(stands(page, 24 * HOUR)).toBe(false);
    expect(stands({ outcome: "file", checkedAt: 0, failures: 0 }, 1)).toBe(
      false,
    );
  });
});

describe("a page's links", () => {
  const html = `
    <a href="/forms/ssa-561.html">Form SSA-561 | Request for Reconsideration</a>
    <a href="/forms/ssa-561.pdf" title="SSA-561"><img src="pdf.gif"></a>
    <a href="/forms/ssa-561.pdf">Download</a>
    <a href="/forms/SSA-561.html">again, in another case</a>
    <a href="mailto:forms@ssa.gov">Write to us</a>
    <a href="#top">Top</a>`;
  const links = labelledLinks(html, "https://www.ssa.gov/forms/");

  test("are each given once, as a PDF or a page, with the page's words", () => {
    expect(links).toEqual([
      {
        url: "https://www.ssa.gov/forms/ssa-561.html",
        label: "Form SSA-561 | Request for Reconsideration",
        pdf: false,
      },
      {
        url: "https://www.ssa.gov/forms/ssa-561.pdf",
        label: "SSA-561",
        pdf: true,
      },
      {
        url: "https://www.ssa.gov/forms/SSA-561.html",
        label: "again, in another case",
        pdf: false,
      },
    ]);
  });
});

test("a web page is told from a file by how it starts", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);
  expect(
    isWebPage(bytes("<!DOCTYPE html><html><body>About form 21-526EZ")),
  ).toBe(true);
  expect(isWebPage(bytes("%PDF-1.7 a form"))).toBe(false);
  expect(isWebPage(bytes("Access denied"))).toBe(false);
});

test("a form is looked up by its code without the agency", () => {
  expect(bareCode("IRS-8822")).toBe("8822");
  expect(bareCode("Form 8822")).toBe("8822");
  expect(bareCode("VA Form 21-526EZ")).toBe("21526EZ");
  expect(bareCode("DL 410 FO")).toBe("410FO");
});

describe("a page that lists forms", () => {
  // As the Social Security forms page is built: every link says the same
  // thing, and the form is named by the heading above it.
  const html = `
    <article><h2 id="ssa-561">SSA-561 Request for Reconsideration</h2>
      <a aria-describedby="ssa-561 form" href="/forms/ssa-561-u2.pdf">English PDF</a>
      <a aria-describedby="ssa-561" href="/forms/ssa-561.html">More Info</a></article>
    <article><h2 id="ssa-1021">SSA-1021 Appeal of Determination</h2>
      <a aria-describedby="ssa-1021 form" href="/forms/ssa-1021.pdf">English PDF</a>
      <a aria-describedby="ssa-1021 instructions" href="/forms/ssa-1021-inst.pdf">English PDF</a></article>`;
  const links = labelledLinks(html, "https://www.ssa.gov/forms/");

  test("gives each link the heading it sits under, and what it describes", () => {
    expect(
      links.map(({ url, label, under }) => [url.slice(26), label, under]),
    ).toEqual([
      [
        "ssa-561-u2.pdf",
        "English PDF",
        "SSA-561 Request for Reconsideration · ssa-561 form",
      ],
      [
        "ssa-561.html",
        "More Info",
        "SSA-561 Request for Reconsideration · ssa-561",
      ],
      [
        "ssa-1021.pdf",
        "English PDF",
        "SSA-1021 Appeal of Determination · ssa-1021 form",
      ],
      [
        "ssa-1021-inst.pdf",
        "English PDF",
        "SSA-1021 Appeal of Determination · ssa-1021 instructions",
      ],
    ]);
  });
});

describe("a file the authority links as the form", () => {
  const renamed =
    "Form SSA-561 (08-2025) UF Discontinue Prior Editions Social Security Administration REQUEST FOR RECONSIDERATION";
  const heading =
    "English PDF SSA-561 Request for Reconsideration · ssa-561 form";

  test("is the form when the page's words and the file both carry its number", () => {
    // Renamed: the file no longer prints the code as it was asked for.
    expect(isTheForm("SSA-561-U2", renamed)).toBe(false);
    expect(isTheForm("SSA-561-U2", renamed, heading)).toBe(true);
  });

  test("is not let through by its file alone, or by the page alone", () => {
    // Words that don't name the form: the link was chosen by its file name.
    expect(isTheForm("SSA-561-U2", renamed, "English PDF")).toBe(false);
    // The page names the form, but the file is some other document.
    expect(isTheForm("SSA-561-U2", "Form SSA-827 (06-2024)", heading)).toBe(
      false,
    );
    expect(isTheForm("SSA-561-U2", "Form SSA-5610 (08-2025)", heading)).toBe(
      false,
    );
  });

  test("a short number says nothing: the whole code has to be printed", () => {
    expect(carriesNumber("DWC 1", "page 1 of 4")).toBe(false);
    expect(isTheForm("DWC 1", "DWC 1 (Rev. 1/2016)", "Claim form")).toBe(true);
  });

  test("prints its edition beside its code, and the later edition is known", () => {
    expect(revisionOf(renamed)).toBe(202508);
    expect(
      revisionOf(
        "Form SSA-561-U2 (12-2016) uf (12-2016) Prior Edition May Be Used",
      ),
    ).toBe(201612);
    // A bracketed number that isn't a month and year is not an edition.
    expect(revisionOf("Call (800) 772-1213 or see page (2)")).toBeUndefined();
  });
});
