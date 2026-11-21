import { describe, expect, test } from "vitest";
import {
  expiredBy,
  languageOf,
  rankForms,
  revisionOf,
  type FormFacts,
} from "./facts";

const ENGLISH =
  "Complete this form if you are renewing your license by mail. The information you give is used for the " +
  "purpose of processing your application, and it is your responsibility to see that the form is signed.";
const SPANISH =
  "Complete este formulario si usted renueva su licencia por correo. La información que usted proporciona se usa " +
  "para el trámite de su solicitud, y es su responsabilidad asegurarse de que el formulario esté firmado con la fecha.";

describe("languageOf", () => {
  test("tells English, Spanish and a bilingual page apart", () => {
    expect(languageOf(ENGLISH)).toBe("en");
    expect(languageOf(SPANISH)).toBe("es");
    expect(languageOf(`${ENGLISH} ${SPANISH}`)).toBe("both");
  });

  test("a page in another script is a translation, whatever English it carries", () => {
    // Seen in the eval: the Korean DWC-1 also prints its English headings.
    const korean =
      "근로자 보상 청구 양식 직장에서 부상을 입었거나 질병에 걸린 경우 이 양식을 작성하여 고용주에게 제출하십시오 " +
      "Workers Compensation Claim Form DWC 1 Employee complete this section and the form";
    expect(languageOf(korean)).toBe("other");
  });

  test("doesn't guess from a few words", () => {
    expect(languageOf("DL 410 FO (REV. 7/2024) WWW")).toBe("unknown");
  });
});

describe("revisionOf", () => {
  test.each([
    ["Page 1 of 3 DL 410 FO (REV. 7/2024) WWW", 202407],
    ["DL 410 FO (REV. 12/2025)", 202512],
    ["Form 8822 (Rev. February 2021)", 202102],
    ["Form 433-A (Rev. 6-2026)", 202606],
    ["Claim for Damages Form (Rev. 12/18)", 201812],
    ["Form I-864 Edition 12/08/21", 202112],
    ["DWC 1 Revised 1/1/2016", 201601],
  ])("%s", (words, revision) => expect(revisionOf(words)).toBe(revision));

  test("is undefined when the page prints no revision", () => {
    expect(
      revisionOf("Request for Reconsideration. Call 1-800-772-1213."),
    ).toBeUndefined();
  });

  test("takes the latest when a page prints several", () => {
    expect(revisionOf("Rev. 1/2020 supersedes Rev. 6/2018")).toBe(202001);
  });
});

describe("rankForms", () => {
  const file = (
    name: string,
    facts: Partial<FormFacts>,
    designated = false,
  ) => ({
    name,
    designated,
    facts: { pages: 2, places: 10, language: "en" as const, ...facts },
  });
  const order = (files: ReturnType<typeof file>[]) =>
    rankForms(files).map((f) => f.name);

  test("the latest revision wins, whichever was found first", () => {
    expect(
      order([
        file("2024", { revision: 202407 }),
        file("2025", { revision: 202512 }),
      ]),
    ).toEqual(["2025", "2024"]);
  });

  test("English or bilingual before a translation, even a newer one", () => {
    expect(
      order([
        file("spanish 2025", { language: "es", revision: 202512 }),
        file("korean 2025", { language: "other", revision: 202512 }),
        file("bilingual 2024", { language: "both", revision: 202407 }),
        file("english 2023", { revision: 202312 }),
      ]),
    ).toEqual([
      "bilingual 2024",
      "english 2023",
      "spanish 2025",
      "korean 2025",
    ]);
  });

  test("a file with places to write in before a booklet", () => {
    expect(
      order([
        file("booklet", { places: 0, revision: 202601 }),
        file("form", { revision: 202001 }),
      ]),
    ).toEqual(["form", "booklet"]);
  });

  test("the authority's own link before a newer file from anywhere else", () => {
    // Seen in the eval: a different form that mentions DWC 1 printed 2020,
    // and the form the authority links as its claim form prints 2016.
    expect(
      order([
        file("typed, 2020", { revision: 202005 }),
        file("the authority's link, 2016", { revision: 201601 }, true),
      ]),
    ).toEqual(["the authority's link, 2016", "typed, 2020"]);
  });

  test("a current file before an expired one, even the one the authority links", () => {
    // An authority's page can go on linking an edition it replaced.
    expect(
      order([
        file("linked, expired 2019", { revision: 201901, expired: true }, true),
        file("given, current 2025", { revision: 202508 }),
      ]),
    ).toEqual(["given, current 2025", "linked, expired 2019"]);
  });

  test("ties keep the order the sources were trusted in", () => {
    expect(order([file("given", {}), file("known", {})])).toEqual([
      "given",
      "known",
    ]);
  });
});

test("a form that prints an expiry is expired once that month is over", () => {
  const at = (date: string) => Date.parse(date);
  const old = "OMB No. 0938-1230 Expires: 04/24 APPLICATION FOR ENROLLMENT";
  expect(expiredBy(old, at("2024-04-30"))).toBe(false);
  expect(expiredBy(old, at("2024-05-01"))).toBe(true);
  expect(expiredBy("Expires 10/31/2027", at("2026-11-21"))).toBe(false);
  expect(expiredBy("Expires: 07/31/2028", at("2026-11-21"))).toBe(false);
  // A form that prints no expiry isn't expired.
  expect(expiredBy("Form 8822 (Rev. February 2021)", at("2030-01-01"))).toBe(
    false,
  );
});
