// The profile's vocabulary: the fixed set of facts about a person, and the
// readings a pack or a form can take from them. Pure: no ctx and no I/O.
//
// A fact is stored once, structured ("name" is its parts, an address is its
// components). A reading is one way of writing a fact down ("fullName",
// "mailingCity"), worked out by code. A pack input whose key is a reading is
// answered from the profile: the key is the meaning, so two packs that ask
// for `mailingZip` are asking for the same thing.
//
// The vocabulary grows by adding entries here. Nothing is ever renamed: a
// saved pack keeps the keys it was written with.
import { v, type Infer } from "convex/values";
import { isDate } from "../dates";

// --- Values -----------------------------------------------------------------

/**
 * A name's parts. `middle` is null when the person has none: that's a fact
 * they stated, unlike a middle name nobody has asked about yet.
 */
export const vName = v.object({
  given: v.string(),
  middle: v.optional(v.union(v.string(), v.null())),
  family: v.string(),
  suffix: v.optional(v.string()),
});
export type Name = Infer<typeof vName>;

/** An address's parts. What a form shows is always rendered from these. */
export const vAddress = v.object({
  street: v.string(),
  /** "Apt", "Ste", "Unit", "Fl"… as the person writes it. */
  unitType: v.optional(v.string()),
  unitNumber: v.optional(v.string()),
  city: v.string(),
  /** In the US, the two-letter code. */
  state: v.string(),
  postalCode: v.string(),
  /** ISO 3166-1 alpha-2. */
  country: v.string(),
  careOf: v.optional(v.string()),
});
export type Address = Infer<typeof vAddress>;

/** "The same as my home address": a pointer, so one edit fixes both. */
export const vSameAs = v.object({ sameAs: v.literal("homeAddress") });

export const vFactValue = v.union(v.string(), vName, vAddress, vSameAs);
export type FactValue = Infer<typeof vFactValue>;

// --- Facts ------------------------------------------------------------------

type FactKind = "name" | "address" | "date" | "phone" | "email";

export type Fact = {
  kind: FactKind;
  label: string;
  /**
   * How long a value is trusted before the person is asked "still right?".
   * Unset for what doesn't change, like a date of birth.
   */
  staleAfterDays?: number;
  /** Kept out of history, logs and anything a model reads. */
  sensitive?: true;
};

const YEAR = 365;

export const FACTS = {
  name: { kind: "name", label: "Legal name" },
  homeAddress: { kind: "address", label: "Home address", staleAfterDays: YEAR },
  mailingAddress: {
    kind: "address",
    label: "Mailing address",
    staleAfterDays: YEAR,
  },
  phone: { kind: "phone", label: "Phone number", staleAfterDays: 2 * YEAR },
  email: { kind: "email", label: "Email address", staleAfterDays: 2 * YEAR },
  birthDate: { kind: "date", label: "Date of birth", sensitive: true },
} as const satisfies Record<string, Fact>;

export type FactKey = keyof typeof FACTS;
export const FACT_KEYS = Object.keys(FACTS) as FactKey[];
export const isFactKey = (key: string): key is FactKey =>
  Object.hasOwn(FACTS, key);

/** The person's facts as they stand, by key. */
export type Facts = Partial<Record<FactKey, FactValue>>;

// --- Checking a value -------------------------------------------------------

const US_STATES = new Set(
  (
    "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN " +
    "MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA " +
    "WV WI WY AS GU MP PR VI AA AE AP"
  ).split(" "),
);

function isObject(
  value: FactValue,
): value is Name | Address | { sameAs: "homeAddress" } {
  return typeof value === "object";
}

/**
 * Tidies a value for `key`, or says what's wrong with it. Checks only what
 * code can know: a state code, a ZIP's shape, a real date.
 */
export function checkFact(
  key: FactKey,
  value: FactValue,
): { value: FactValue } | { problem: string } {
  const { kind } = FACTS[key];
  if (kind === "name") {
    if (!isObject(value) || !("family" in value))
      return { problem: "Give the name's parts." };
    const given = value.given.trim();
    const family = value.family.trim();
    if (!given || !family) {
      return { problem: "A name needs a given name and a family name." };
    }
    const middle =
      value.middle === null ? null : value.middle?.trim() || undefined;
    return {
      value: {
        given,
        middle,
        family,
        suffix: value.suffix?.trim() || undefined,
      },
    };
  }
  if (kind === "address") {
    if (isObject(value) && "sameAs" in value) {
      return key === "mailingAddress"
        ? { value }
        : { problem: "Only the mailing address can follow the home address." };
    }
    if (!isObject(value) || !("street" in value))
      return { problem: "Give the address's parts." };
    const address: Address = {
      street: value.street.trim(),
      unitType: value.unitType?.trim() || undefined,
      unitNumber: value.unitNumber?.trim() || undefined,
      city: value.city.trim(),
      state: value.state.trim(),
      postalCode: value.postalCode.trim(),
      country: value.country.trim().toUpperCase() || "US",
      careOf: value.careOf?.trim() || undefined,
    };
    if (!address.street || !address.city) {
      return { problem: "An address needs a street and a city." };
    }
    if (!/^[A-Z]{2}$/.test(address.country)) {
      return { problem: 'Use a two-letter country code, like "US".' };
    }
    if (address.country === "US") {
      address.state = address.state.toUpperCase();
      if (!US_STATES.has(address.state)) {
        return { problem: 'Use the two-letter state code, like "CA".' };
      }
      if (!/^\d{5}(-\d{4})?$/.test(address.postalCode)) {
        return { problem: "Use a ZIP code like 94612 or 94612-1234." };
      }
    }
    if (address.unitNumber && !address.unitType) address.unitType = "Unit";
    return { value: address };
  }
  if (typeof value !== "string") return { problem: "Give this as text." };
  const text = value.trim();
  if (kind === "date") {
    return isDate(text)
      ? { value: text }
      : { problem: "Use a date like 1990-04-23." };
  }
  if (kind === "email") {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)
      ? { value: text }
      : { problem: "That doesn't look like an email address." };
  }
  // A phone number: keep what they typed, if there are enough digits in it.
  return text.replace(/\D/g, "").length >= 7
    ? { value: text }
    : { problem: "That doesn't look like a phone number." };
}

// --- Readings ---------------------------------------------------------------

/** The address a fact holds, following "same as home". */
function addressOf(facts: Facts, key: "homeAddress" | "mailingAddress") {
  const value = facts[key];
  if (value === undefined || typeof value === "string") return undefined;
  if ("sameAs" in value) return addressOf(facts, "homeAddress");
  return "street" in value ? value : undefined;
}

const nameOf = (facts: Facts) => {
  const value = facts.name;
  return value !== undefined && typeof value !== "string" && "family" in value
    ? value
    : undefined;
};

const unit = (a: Address) =>
  a.unitNumber ? `${a.unitType ?? "Unit"} ${a.unitNumber}` : "";
const street = (a: Address) => [a.street, unit(a)].filter(Boolean).join(", ");
const cityStateZip = (a: Address) =>
  `${a.city}, ${[a.state, a.postalCode].filter(Boolean).join(" ")}`;
const lines = (a: Address) => [
  ...(a.careOf ? [`c/o ${a.careOf}`] : []),
  street(a),
  cityStateZip(a),
  ...(a.country === "US" ? [] : [a.country]),
];

/** The readings of one address, under a prefix: "mailing" gives `mailingCity`. */
function addressReadings(prefix: "home" | "mailing", label: string) {
  const fact = `${prefix}Address` as const;
  const read =
    (write: (a: Address) => string) =>
    (facts: Facts): string | undefined => {
      const address = addressOf(facts, fact);
      return address && write(address);
    };
  const reading = (
    suffix: string,
    what: string,
    write: (a: Address) => string,
  ) =>
    [
      `${prefix}${suffix}`,
      { fact, label: `${label} ${what}`, read: read(write) },
    ] as const;
  return [
    // The whole address, as on an envelope.
    [fact, { fact, label, read: read((a) => lines(a).join("\n")) }] as const,
    reading("AddressLine", "(one line)", (a) => lines(a).join(", ")),
    reading("Street", "street, with any unit", street),
    reading("StreetOnly", "street, without the unit", (a) => a.street),
    reading("Unit", "apartment or unit", unit),
    reading("City", "city", (a) => a.city),
    reading("State", "state", (a) => a.state),
    reading("Zip", "ZIP code", (a) => a.postalCode.slice(0, 5)),
    reading("Zip4", "ZIP+4 extension", (a) => a.postalCode.slice(6)),
    reading("CityStateZip", "city, state and ZIP", cityStateZip),
  ];
}

export type Reading = {
  /** The fact it's read from: the one thing to ask for when it's missing. */
  fact: FactKey;
  label: string;
  /** Undefined while the fact is unknown. "" is an answer: there is none. */
  read: (facts: Facts) => string | undefined;
};

const text = (fact: FactKey) => (facts: Facts) => {
  const value = facts[fact];
  return typeof value === "string" ? value : undefined;
};
const namePart = (write: (name: Name) => string) => (facts: Facts) => {
  const name = nameOf(facts);
  return name && write(name);
};

export const READINGS: Record<string, Reading> = Object.fromEntries([
  [
    "fullName",
    {
      fact: "name",
      label: "Full legal name",
      read: namePart((n) =>
        [n.given, n.middle, n.family, n.suffix].filter(Boolean).join(" "),
      ),
    },
  ],
  [
    "givenName",
    { fact: "name", label: "Given name", read: namePart((n) => n.given) },
  ],
  [
    "middleName",
    {
      fact: "name",
      label: "Middle name",
      // Unknown until they say: a blank box and "none" aren't the same.
      read: (facts: Facts) => {
        const name = nameOf(facts);
        if (!name || name.middle === undefined) return undefined;
        return name.middle ?? "";
      },
    },
  ],
  [
    "middleInitial",
    {
      fact: "name",
      label: "Middle initial",
      read: (facts: Facts) => {
        const name = nameOf(facts);
        if (!name || name.middle === undefined) return undefined;
        return name.middle?.[0]?.toUpperCase() ?? "";
      },
    },
  ],
  [
    "familyName",
    { fact: "name", label: "Family name", read: namePart((n) => n.family) },
  ],
  ...addressReadings("home", "Home address"),
  ...addressReadings("mailing", "Mailing address"),
  ["phone", { fact: "phone", label: "Phone number", read: text("phone") }],
  ["email", { fact: "email", label: "Email address", read: text("email") }],
  [
    "birthDate",
    { fact: "birthDate", label: "Date of birth", read: text("birthDate") },
  ],
]);

export const isReading = (key: string) => Object.hasOwn(READINGS, key);

/** The fact behind an input key, if the key is a reading. */
export function factOf(key: string): FactKey | undefined {
  return isReading(key) ? READINGS[key].fact : undefined;
}

/** The facts a set of input keys reads, each once, in the inputs' order. */
export function factsRead(inputs: string[]): FactKey[] {
  return [...new Set(inputs.flatMap((key) => factOf(key) ?? []))];
}

/**
 * A full name typed into one box, as parts: only when it's two words, where
 * there's no doubt which is which. Anything else needs the person.
 */
export function nameFromText(text: string): Name | undefined {
  const words = text.trim().split(/\s+/);
  return words.length === 2 ? { given: words[0], family: words[1] } : undefined;
}
