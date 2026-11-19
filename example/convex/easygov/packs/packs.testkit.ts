// Process packs the tests seed as shared rows. Packs live only in the
// `processPacks` table; these are test data, not built-ins. The extra dot
// keeps Convex from deploying this file.
import type { Infer } from "convex/values";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import type { T } from "../case/cases.testkit";
import type { vProcessPackDefinition } from "./schema";

type PackDefinition = Infer<typeof vProcessPackDefinition>;

/** IRS Form 8822: change of address. */
export const irs8822: PackDefinition = {
  title: "IRS change of address (Form 8822)",
  description:
    "Prepare Form 8822 for a change to an individual mailing address.",
  aliases: ["update IRS home address", "IRS mailing address change"],
  jurisdiction: "us",
  authority: "Internal Revenue Service",
  forms: ["IRS-8822"],
  inputs: ["fullName", "oldAddress", "newAddress"],
  delivery: "mail",
};

/** SSA request for reconsideration of a denied claim. */
export const ssaAppeal: PackDefinition = {
  title: "Social Security appeal (reconsideration)",
  description: "Request reconsideration of a denied Social Security claim.",
  aliases: ["appeal SSA denial", "Social Security denied claim"],
  jurisdiction: "us",
  authority: "Social Security Administration",
  forms: ["SSA-561"],
  inputs: ["fullName", "denialDate", "reasonForAppeal", "wantsRepresentation"],
  referral: {
    kind: "representation",
    when: { input: "wantsRepresentation", equals: "yes" },
  },
  delivery: "online",
};

/**
 * A demand letter for unpaid wages: a file, a deadline, a letter, and a
 * referral offered when enough is owed. Not seeded by `seedPacks`.
 */
export const wageClaim: PackDefinition = {
  title: "Unpaid wages demand letter",
  description: "Write to an employer demanding wages that are owed.",
  aliases: ["final paycheck not paid", "employer owes me money"],
  jurisdiction: "us/ca",
  authority: "Labor Commissioner",
  forms: [],
  inputs: ["fullName", "employer", "amountOwed", "lastWorkDate"],
  documents: [
    { key: "payStub", label: "Your last pay stub", required: true },
    { key: "contract", label: "Your offer letter", required: false },
  ],
  deadline: {
    label: "File a wage claim",
    fromInput: "lastWorkDate",
    days: 1095,
  },
  referral: {
    kind: "employment",
    when: { input: "amountOwed", atLeast: 5000 },
  },
  output: {
    title: "Demand letter",
    checklist: ["Send the letter and keep a copy."],
    letter:
      "To {{employer}}: I, {{fullName}}, am owed ${{amountOwed}} in wages.",
  },
};

/** Saves the fixture packs as shared packs, through the same checks as any save. */
export async function seedPacks(t: T) {
  // The fixtures are distinct processes, so each acknowledges the ones before.
  const reviewedPackIds: Id<"processPacks">[] = [];
  for (const pack of [irs8822, ssaAppeal]) {
    const saved = await t.mutation(internal.easygov.packs.data.save, {
      ...pack,
      reviewedPackIds,
    });
    if (saved.kind !== "created")
      throw new Error(`Could not seed ${pack.title}`);
    reviewedPackIds.push(saved.id);
  }
}

/** The selection model's first reply for a request, as the mock returns it. */
export function request(fields: {
  kind?: "process" | "referral" | "unclear";
  message?: string;
  jurisdiction?: string;
  authority?: string;
  forms?: string[];
  searchTerms?: string;
}) {
  return JSON.stringify({
    kind: "process",
    message: "Let me find the process.",
    ...fields,
  });
}

/** The selection model's pick among numbered candidates; 0 is none. */
export const choose = (choice: number) => JSON.stringify({ choice });
