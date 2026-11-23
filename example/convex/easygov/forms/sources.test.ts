import { describe, expect, test } from "vitest";
import { namesForm, notAPdf, sameFormCode, selfDescribed } from "./sources";

test("a federal series is the same spelled out or not", () => {
  expect(sameFormCode("Standard Form 180", "SF-180")).toBe(true);
  expect(sameFormCode("Optional Form 74", "OF 74")).toBe(true);
  expect(sameFormCode("Standard Form 180", "SF-181")).toBe(false);
});

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
    // A word after the code labels the authority's copy of the same form.
    expect(namesForm("PVO-0100", "PVO-0100-online (Rev. 02.5.2024)")).toBe(
      true,
    );
  });

  test.each([
    ["SS-5", "Form W-9 (Rev. 2015)"],
    ["I-864", "Form I-864A Contract Between Sponsor and Household Member"],
    ["IRS-8822", "Form 8822-B Change of Address or Responsible Party"],
    ["SSA-561", "Form SSA-561-U2 (12-2016)"],
    ["IRS-1040", "Form 1040-ES Estimated Tax"],
    ["DL 410 FO", "DL 410 ID"],
  ])(
    "%s is not named by %j: a stray number or a suffix is another form",
    (code, text) => {
      expect(namesForm(code, text)).toBe(false);
    },
  );
});

test("a page says of itself its title and its footer's words", () => {
  expect(
    selfDescribed(
      "<title>Inland  Revenue</title><footer><p>© New Zealand&nbsp;Government</p></footer>",
    ),
  ).toEqual({ title: "Inland Revenue", footer: "© New Zealand Government" });
  expect(selfDescribed("<p>No title</p>")).toEqual({});
});
