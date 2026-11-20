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
  // The old address starts as today's home address; the new one becomes it.
  profile: [
    { input: "oldAddress", reads: "homeAddressLine" },
    { input: "newAddress", updates: "homeAddress" },
  ],
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
  evidence: [
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

// The three below are contested matters: the person is disputing a decision
// or an employer, which is where a lawyer is worth offering. Their deadlines
// and form numbers are drafted from the authorities' public guidance and
// need a lawyer's review before anyone relies on them. Not seeded by
// `seedPacks`.

const yesNo = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
];

/** A charge of employment discrimination, prepared for the EEOC's intake. */
export const eeocCharge: PackDefinition = {
  title: "EEOC charge of discrimination",
  description:
    "Prepare a statement of employment discrimination for the EEOC, which drafts the charge from it.",
  aliases: [
    "fired because of my race, sex, age, religion or disability",
    "workplace discrimination or harassment complaint",
    "retaliation for complaining about discrimination",
  ],
  jurisdiction: "us",
  authority: "Equal Employment Opportunity Commission",
  forms: ["EEOC-5"],
  inputs: [
    "fullName",
    "employer",
    "employeeCount",
    "basis",
    "whatHappened",
    "lastIncidentDate",
    "stillEmployed",
    "lostJobOrPay",
  ],
  inputQuestions: [
    { key: "fullName", question: "Your full name" },
    { key: "employer", question: "The employer's name" },
    {
      key: "employeeCount",
      question: "About how many people work there? (a number)",
    },
    {
      key: "basis",
      question: "What was it because of?",
      multiple: true,
      choices: [
        { value: "race", label: "Race or color" },
        {
          value: "sex",
          label: "Sex, pregnancy, orientation or gender identity",
        },
        { value: "age", label: "Age (40 or older)" },
        { value: "disability", label: "Disability" },
        { value: "religion", label: "Religion" },
        { value: "origin", label: "National origin" },
        { value: "retaliation", label: "Retaliation for complaining" },
      ],
    },
    { key: "whatHappened", question: "What happened, in your own words?" },
    {
      key: "lastIncidentDate",
      question: "When did it last happen? (YYYY-MM-DD)",
    },
    {
      key: "stillEmployed",
      question: "Do you still work there?",
      choices: yesNo,
    },
    {
      key: "lostJobOrPay",
      question: "Did you lose your job, a promotion or pay over it?",
      choices: yesNo,
    },
  ],
  evidence: [
    {
      key: "notice",
      label: "A termination letter, write-up or message about it",
      required: false,
    },
  ],
  deadline: {
    label:
      "File the charge (180 days; 300 where a state agency also covers it)",
    fromInput: "lastIncidentDate",
    days: 180,
  },
  referral: {
    kind: "discrimination",
    when: { input: "lostJobOrPay", equals: "yes" },
    orWhen: [
      { input: "stillEmployed", equals: "no" },
      // Most of the filing window is already gone.
      { input: "lastIncidentDate", withinDays: 180 },
    ],
    priceCents: 15000,
  },
  output: {
    title: "Statement for the EEOC",
    checklist: [
      "Open an inquiry in the EEOC Public Portal, or call 1-800-669-4000.",
      "Give the intake interviewer this statement and your documents.",
      "Read the charge the EEOC drafts before you sign it.",
      "Keep a copy of the signed charge and its number.",
    ],
    letter:
      "I, {{fullName}}, worked for {{employer}}, which has about {{employeeCount}} employees. " +
      "I believe I was discriminated against because of: {{basis}}. " +
      "{{whatHappened}} This last happened on {{lastIncidentDate}}. " +
      "Still employed there: {{stillEmployed}}. Lost my job, a promotion or pay: {{lostJobOrPay}}.",
  },
  delivery: "online",
};

/** A review of a VA benefits decision: which lane, and what to send. */
export const vaDecisionReview: PackDefinition = {
  title: "VA decision review (disability claim)",
  description:
    "Ask the VA to review a denied or under-rated disability claim: a supplemental claim, a higher-level review, or a Board appeal.",
  aliases: [
    "VA denied my disability claim",
    "appeal my VA rating",
    "VA supplemental claim or higher-level review",
  ],
  jurisdiction: "us",
  authority: "Department of Veterans Affairs",
  forms: ["VA-20-0995", "VA-20-0996", "VA-10182"],
  inputs: [
    "fullName",
    "decisionDate",
    "condition",
    "whyWrong",
    "hasNewEvidence",
    "priorReviews",
    "wantsRepresentation",
  ],
  inputQuestions: [
    { key: "fullName", question: "Your full name" },
    {
      key: "decisionDate",
      question: "The date on the VA's decision letter (YYYY-MM-DD)",
    },
    {
      key: "condition",
      question: "The condition or issue the decision was about",
    },
    { key: "whyWrong", question: "Why do you think the decision is wrong?" },
    {
      key: "hasNewEvidence",
      question: "Do you have evidence the VA hasn't seen yet?",
      choices: yesNo,
    },
    {
      key: "priorReviews",
      question:
        "How many times has this decision been reviewed already? (a number)",
    },
    {
      key: "wantsRepresentation",
      question:
        "Would you like an accredited attorney or agent to take this on?",
      choices: yesNo,
    },
  ],
  evidence: [
    {
      key: "decisionLetter",
      label: "The VA's decision letter",
      required: true,
    },
    {
      key: "newEvidence",
      label: "New medical records or statements",
      required: false,
    },
  ],
  deadline: {
    label: "Ask for the review (one year from the decision)",
    fromInput: "decisionDate",
    days: 365,
  },
  referral: {
    kind: "veterans",
    when: { input: "wantsRepresentation", equals: "yes" },
    // Already reviewed once and still denied: the next step is the Board.
    orWhen: [{ input: "priorReviews", atLeast: 1 }],
    priceCents: 10000,
  },
  output: {
    title: "Decision review request",
    tailorBy: ["hasNewEvidence", "priorReviews"],
    checklist: [
      "With new evidence: file a Supplemental Claim (VA Form 20-0995) and attach it.",
      "With no new evidence: ask for a Higher-Level Review (VA Form 20-0996).",
      "After a review that didn't change it: appeal to the Board (VA Form 10182).",
      "File on VA.gov, by mail, or with a Veterans Service Organization.",
      "Keep the confirmation and the date you filed.",
    ],
    letter:
      "I, {{fullName}}, ask for review of the VA decision dated {{decisionDate}} about {{condition}}. " +
      "{{whyWrong}} New evidence not yet considered: {{hasNewEvidence}}. " +
      "Earlier reviews of this decision: {{priorReviews}}. " +
      "I would like a representative: {{wantsRepresentation}}.",
  },
  delivery: "online",
};

/** An appeal of a California unemployment (EDD) determination. */
export const uiAppealCa: PackDefinition = {
  title: "Unemployment appeal (California EDD)",
  description:
    "Appeal an EDD notice that denies or reduces unemployment benefits, or says you were overpaid.",
  aliases: [
    "EDD denied my unemployment",
    "appeal unemployment disqualification",
    "EDD says I was overpaid",
  ],
  jurisdiction: "us/ca",
  authority: "Employment Development Department",
  forms: ["DE-1000M"],
  inputs: [
    "fullName",
    "noticeDate",
    "noticeReason",
    "whyDisagree",
    "overpaymentAmount",
    "fraudAlleged",
  ],
  inputQuestions: [
    { key: "fullName", question: "Your full name" },
    {
      key: "noticeDate",
      question: "The mailing date on the EDD notice (YYYY-MM-DD)",
    },
    { key: "noticeReason", question: "The reason the notice gives" },
    { key: "whyDisagree", question: "Why do you disagree?" },
    {
      key: "overpaymentAmount",
      question: "If EDD says you were overpaid, how much? (a number; 0 if not)",
    },
    {
      key: "fraudAlleged",
      question: "Does the notice say you gave false information?",
      choices: yesNo,
    },
  ],
  evidence: [
    { key: "notice", label: "The EDD notice you're appealing", required: true },
    {
      key: "separation",
      label: "Anything from your employer about why the job ended",
      required: false,
    },
  ],
  deadline: {
    label: "Send the appeal (30 days from the notice's mailing date)",
    fromInput: "noticeDate",
    days: 30,
  },
  referral: {
    kind: "unemployment",
    when: { input: "fraudAlleged", equals: "yes" },
    orWhen: [{ input: "overpaymentAmount", atLeast: 2000 }],
    priceCents: 7500,
  },
  output: {
    title: "Appeal letter",
    checklist: [
      "Send this letter or Appeal Form DE 1000M to the EDD office on the notice.",
      "Keep certifying for benefits while the appeal is pending.",
      "Watch for the hearing notice from the Appeals Board, and attend.",
      "Bring the notice, this letter and your documents to the hearing.",
    ],
    letter:
      "I, {{fullName}}, appeal the EDD notice mailed on {{noticeDate}}, which says: {{noticeReason}}. " +
      "I disagree because: {{whyDisagree}} " +
      "Overpayment claimed: ${{overpaymentAmount}}. False statement alleged: {{fraudAlleged}}.",
  },
  delivery: "mail",
};

/** Saves the fixture packs as shared packs, through the same checks as any save. */
export async function seedPacks(t: T) {
  // The fixtures are distinct processes, so each acknowledges the ones before.
  const reviewedPackIds: Id<"processPacks">[] = [];
  for (const pack of [irs8822, ssaAppeal]) {
    const saved = await t.mutation(internal.easygov.packs.data.createPack, {
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
