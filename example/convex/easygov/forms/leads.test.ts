import { expect, test } from "vitest";
import { leadsFrom } from "./sources";

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
