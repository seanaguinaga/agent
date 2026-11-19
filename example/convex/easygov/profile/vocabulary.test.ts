import { describe, expect, test } from "vitest";
import {
  checkFact,
  factsRead,
  nameFromText,
  READINGS,
  type Facts,
} from "./vocabulary";

const read = (key: string, facts: Facts) => READINGS[key].read(facts);
const home = {
  street: "2 New Street",
  unitType: "Apt",
  unitNumber: "4B",
  city: "Berkeley",
  state: "CA",
  postalCode: "94704-1234",
  country: "US",
};

describe("a name", () => {
  const name = { given: "Ada", middle: "King", family: "Lovelace" };
  test("is read whole, in parts, and as an initial", () => {
    expect(read("fullName", { name })).toBe("Ada King Lovelace");
    expect(read("givenName", { name })).toBe("Ada");
    expect(read("familyName", { name })).toBe("Lovelace");
    // An initial is worked out, never a name squeezed into the box.
    expect(read("middleInitial", { name })).toBe("K");
  });

  test("a middle name is unknown until they say, and 'none' is an answer", () => {
    const unsaid = { given: "Ada", family: "Lovelace" };
    expect(read("middleName", { name: unsaid })).toBeUndefined();
    expect(read("fullName", { name: unsaid })).toBe("Ada Lovelace");
    const none = { ...unsaid, middle: null };
    expect(read("middleName", { name: none })).toBe("");
    expect(read("middleInitial", { name: none })).toBe("");
    expect(read("fullName", {})).toBeUndefined();
  });

  test("one typed into a single box is split only when it's two words", () => {
    expect(nameFromText(" Ada  Lovelace ")).toEqual({
      given: "Ada",
      family: "Lovelace",
    });
    expect(nameFromText("Ada King Lovelace")).toBeUndefined();
  });
});

describe("an address", () => {
  test("is stored as parts and written however the form cuts it", () => {
    const facts = { homeAddress: home };
    expect(read("homeAddress", facts)).toBe(
      "2 New Street, Apt 4B\nBerkeley, CA 94704-1234",
    );
    expect(read("homeAddressLine", facts)).toBe(
      "2 New Street, Apt 4B, Berkeley, CA 94704-1234",
    );
    expect(read("homeStreetOnly", facts)).toBe("2 New Street");
    expect(read("homeUnit", facts)).toBe("Apt 4B");
    expect(read("homeCity", facts)).toBe("Berkeley");
    expect(read("homeZip", facts)).toBe("94704");
    expect(read("homeZip4", facts)).toBe("1234");
    expect(read("homeCityStateZip", facts)).toBe("Berkeley, CA 94704-1234");
  });

  test("a mailing address can follow the home address", () => {
    const facts: Facts = {
      homeAddress: home,
      mailingAddress: { sameAs: "homeAddress" },
    };
    expect(read("mailingCity", facts)).toBe("Berkeley");
    // Change the home address once, and both move.
    expect(
      read("mailingCity", {
        ...facts,
        homeAddress: { ...home, city: "Oakland" },
      }),
    ).toBe("Oakland");
    // Following an address that isn't known yet is still unknown.
    expect(
      read("mailingCity", { mailingAddress: { sameAs: "homeAddress" } }),
    ).toBeUndefined();
  });

  test("is checked for what code can know", () => {
    expect(checkFact("homeAddress", { ...home, state: "ca" })).toMatchObject({
      value: { state: "CA" },
    });
    expect(checkFact("homeAddress", { ...home, state: "Calif" })).toEqual({
      problem: 'Use the two-letter state code, like "CA".',
    });
    expect(checkFact("homeAddress", { ...home, postalCode: "9470" })).toEqual({
      problem: "Use a ZIP code like 94612 or 94612-1234.",
    });
    // A foreign address isn't held to US rules.
    expect(
      checkFact("homeAddress", {
        ...home,
        state: "ON",
        postalCode: "M5V 2T6",
        country: "ca",
      }),
    ).toMatchObject({ value: { country: "CA", postalCode: "M5V 2T6" } });
    expect(checkFact("homeAddress", { sameAs: "homeAddress" })).toHaveProperty(
      "problem",
    );
  });
});

test("simple facts are checked by their kind", () => {
  expect(checkFact("birthDate", "1990-02-31")).toHaveProperty("problem");
  expect(checkFact("birthDate", " 1990-04-23 ")).toEqual({
    value: "1990-04-23",
  });
  expect(checkFact("email", "ada@example")).toHaveProperty("problem");
  expect(checkFact("phone", "(510) 555-0100")).toEqual({
    value: "(510) 555-0100",
  });
  expect(checkFact("name", { given: "Ada", family: " " })).toHaveProperty(
    "problem",
  );
});

test("inputs say which facts they read, each once", () => {
  expect(
    factsRead([
      "fullName",
      "citationNumber",
      "mailingCity",
      "mailingZip",
      "givenName",
    ]),
  ).toEqual(["name", "mailingAddress"]);
});
