import { describe, expect, test } from "vitest";
import { isOfficialHost, namesForm, notAPdf } from "./sources";

const pdf = new TextEncoder().encode("%PDF-1.7 a form");
const page = new TextEncoder().encode("<html>Access denied</html>");
describe("getting a form's bytes", () => {
  test("the bytes have to be a PDF, and name the form they're meant to be", () => {
    expect(notAPdf(pdf)).toBeNull();
    expect(notAPdf(page)).toBe("It isn't a PDF.");
    expect(
      namesForm("IRS-8822", "Form 8822 (Rev. February 2021) Change of Address"),
    ).toBe(true);
    expect(
      namesForm("SSA SS-5", "Form SS-5 Application for a Social Security Card"),
    ).toBe(true);
    expect(
      namesForm("W-9", "Form W-9 Request for Taxpayer Identification"),
    ).toBe(true);
    expect(
      namesForm("IRS-8822", "Form 8821 Tax Information Authorization"),
    ).toBe(false);
  });

  test.each([
    ["SS-5", "Form W-9 (Rev. 2015)"],
    ["I-864", "Form I-864A Contract Between Sponsor and Household Member"],
    ["IRS-8822", "Form 8822-B Change of Address or Responsible Party"],
    ["SSA-561", "Form SSA-561-U2 (12-2016)"],
    ["DL 410 FO", "DL 410 ID"],
  ])(
    "%s is not named by %j: a stray number or a suffix is another form",
    (code, text) => {
      expect(namesForm(code, text)).toBe(false);
    },
  );
});

test("only a .gov host is a government's own by its name: an open name like .us is not", () => {
  expect(isOfficialHost("https://www.ssa.gov/forms/ssa-561.pdf")).toBe(true);
  expect(isOfficialHost("https://forms-irs.us/f8822.pdf")).toBe(false);
  expect(isOfficialHost("http://www.ssa.gov/forms")).toBe(false);
  expect(isOfficialHost("https://ssa.gov.example.com/")).toBe(false);
});

test("a government's site outside .gov counts only if it is kept by hand", () => {
  expect(isOfficialHost("https://www.acgov.org/forms/a.pdf")).toBe(true);
  expect(isOfficialHost("https://www.army.mil/forms")).toBe(true);
  expect(isOfficialHost("https://notacgov.org/a.pdf")).toBe(false);
  expect(isOfficialHost("https://acgov.org.example.com/a.pdf")).toBe(false);
  expect(isOfficialHost("https://www.dmv.org/forms/a.pdf")).toBe(false);
});
