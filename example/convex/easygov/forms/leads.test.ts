import { expect, test } from "vitest";
import {
  labelledPdfLinks,
  leadsFrom,
  shortlist,
  sameFormCode,
} from "./sources";

test("an address with no language marker is tried as given", () => {
  const url = "https://agency.gov/uploads/2025/12/DL-410-FO-R12-2025.pdf";
  expect(leadsFrom(url)).toEqual([url]);
});

test("a translation's address is tried without its marker first", () => {
  expect(
    leadsFrom(
      "https://www.dmv.ca.gov/portal/uploads/2025/12/DL-410-FO-SP-R12-2025-ASB-WWW.pdf",
    ),
  ).toEqual([
    "https://www.dmv.ca.gov/portal/uploads/2025/12/DL-410-FO-R12-2025-ASB-WWW.pdf",
    "https://www.dmv.ca.gov/portal/uploads/2025/12/DL-410-FO-SP-R12-2025-ASB-WWW.pdf",
  ]);
  expect(
    leadsFrom("https://agency.gov/uploads/2025/FORM-10-SP.PDF?v=2"),
  ).toEqual([
    "https://agency.gov/uploads/2025/FORM-10.PDF?v=2",
    "https://agency.gov/uploads/2025/FORM-10-SP.PDF?v=2",
  ]);
  expect(leadsFrom("https://agency.gov/f/DL_410_FO_SP.pdf")[0]).toBe(
    "https://agency.gov/f/DL_410_FO.pdf",
  );
});

test("a translated folder is tried in English, then without the folder", () => {
  expect(leadsFrom("https://agency.gov/es/forms/app.pdf")).toEqual([
    "https://agency.gov/en/forms/app.pdf",
    "https://agency.gov/forms/app.pdf",
    "https://agency.gov/es/forms/app.pdf",
  ]);
});

test("letters inside a word are not a marker", () => {
  const url = "https://agency.gov/forms/espanol-guide-spouse.pdf";
  expect(leadsFrom(url)).toEqual([url]);
});

test("labelledPdfLinks gives each PDF link once, with the page's words for it", () => {
  const html = `
    <a href="/pub/irs-pdf/f8822.pdf"><span>Form 8822</span>, Change of&nbsp;Address</a>
    <a href='https://www.irs.gov/pub/irs-pdf/f8822.pdf'>again</a>
    <a href="/forms/about-form-8822">about</a>
    <a class="x" title="Renewal by mail &amp; eligibility" href="/portal/file/dl-410-pdf/?a=1&amp;b=2"><img src="i.png"></a>
    <a href="#top">top</a>`;
  expect(
    labelledPdfLinks(html, "https://www.irs.gov/faqs/address-changes"),
  ).toEqual([
    {
      url: "https://www.irs.gov/pub/irs-pdf/f8822.pdf",
      label: "Form 8822 , Change of Address",
    },
    {
      url: "https://www.irs.gov/portal/file/dl-410-pdf/?a=1&b=2",
      label: "Renewal by mail & eligibility",
    },
  ]);
});

test("shortlist keeps the links that share the most with the code, in order", () => {
  const link = (label: string, file: string) => ({
    label,
    url: `https://x.gov/${file}`,
  });
  const links = [
    link("Annual report", "report2025.pdf"),
    link("Claim form (DWC 1)", "DWCForm1.pdf"),
    link("DWC-AD 10133.36", "dwcad10133.pdf"),
    link("Guide for injured workers", "guide.pdf"),
    link("Form 1 instructions", "one.pdf"),
  ];
  expect(shortlist(links, "DWC 1").map((l) => l.label)).toEqual([
    "Claim form (DWC 1)",
    "DWC-AD 10133.36",
    "Form 1 instructions",
  ]);
  expect(shortlist(links, "Renewal notice")).toEqual([]);
});

test.each([
  ["IRS-8822", "Form 8822"],
  ["DL 410 FO", "DL-410-FO"],
  ["USCIS-I-864", "I-864"],
  ["DWC-1", "DWC Form 1"],
  ["VA-21-526EZ", "VA Form 21-526EZ"],
])("%s and %s are one form", (a, b) => {
  expect(sameFormCode(a, b)).toBe(true);
  expect(sameFormCode(b, a)).toBe(true);
});

test.each([
  ["IRS-8822", "Form 8822-B"],
  ["DL 410 FO", "DL 410 ID"],
  ["I-864", "I-864EZ"],
  ["SUM-100", "CM-010"],
  ["DWC 1", "RCI 1"],
  ["Renewal notice", "Renewal notice"],
])("%s and %s are not known to be one form", (a, b) => {
  expect(sameFormCode(a, b)).toBe(false);
});
