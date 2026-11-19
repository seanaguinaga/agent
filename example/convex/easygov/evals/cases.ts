// The eval cases, one list per slice. They live in code so they're typed and
// reviewed like any other change; results live in the tables.
//
// A slice is one model call run on its own with fixed inputs ("intake",
// "request", "choose", "research", "draft", "prefill"), the pack search with no model
// ("search"), stage 1 end to end ("outcome"), or a whole case ("pipeline").
import type { PilotOptions } from "../autopilot";
import type { Candidate, Question, Subject } from "../case/agents";
import type {
  Outcome,
  PipelineExpectation,
  PrefillExpectation,
  RequestExpectation,
} from "./grading";

// --- Intake: one message in, a goal or a question back ----------------------

export const intake: { id: string; message: string; expect: "goal" | "ask" }[] =
  [
    {
      id: "clear request",
      message: "I moved and need to tell the IRS my new address.",
      expect: "goal",
    },
    {
      id: "clear, with a place",
      message: "I need to renew my California driver's license.",
      expect: "goal",
    },
    { id: "vague", message: "I got a letter.", expect: "ask" },
    { id: "greeting", message: "Hi, can you help me?", expect: "ask" },
  ];

// --- Request: a goal in; its kind, place and forms out ----------------------

export const request: ({ id: string; goal: string } & RequestExpectation)[] = [
  {
    id: "federal form",
    goal: "Tell the IRS my new mailing address.",
    kinds: ["process"],
    jurisdictions: ["us"],
    forms: ["IRS-8822"],
  },
  {
    id: "state",
    goal: "Renew a California driver's license.",
    kinds: ["process"],
    jurisdictions: ["us/ca"],
  },
  {
    id: "city",
    goal: "Contest an Oakland, California parking ticket for an unclear red-zone marking.",
    kinds: ["process"],
    jurisdictions: ["us/ca/alameda", "us/ca/oakland", "us/ca/alameda/oakland"],
  },
  {
    id: "federal, no form named",
    goal: "Social Security denied my disability claim and I want to appeal.",
    kinds: ["process"],
    jurisdictions: ["us"],
  },
  {
    id: "immigration",
    goal: "Help a U.S. citizen obtain a green card for her husband.",
    kinds: ["process"],
    jurisdictions: ["us"],
  },
  {
    id: "legal advice",
    goal: "Should I sue my landlord in California for keeping my deposit?",
    kinds: ["referral"],
    jurisdictions: ["us/ca"],
  },
  {
    id: "wants a lawyer",
    goal: "I need a lawyer for a DUI charge in Texas.",
    kinds: ["referral"],
    jurisdictions: ["us/tx"],
  },
  { id: "unclear", goal: "I got a letter.", kinds: ["unclear"] },
  {
    // No place: it must not guess one. Asking is right; so is "process"
    // with no jurisdiction, which makes the pipeline ask.
    id: "no place given",
    goal: "Renew my license.",
    kinds: ["unclear", "process"],
    jurisdictions: [null],
  },
];

// --- Choose: a goal and candidates in; a number, or 0 for none --------------

const irs: Candidate = {
  title: "IRS change of address (Form 8822)",
  description:
    "Prepare Form 8822 for a change to an individual mailing address.",
  jurisdiction: "us",
  authority: "Internal Revenue Service",
  forms: ["IRS-8822"],
};
const ssa: Candidate = {
  title: "Social Security appeal (reconsideration)",
  description: "Request reconsideration of a denied Social Security claim.",
  jurisdiction: "us",
  authority: "Social Security Administration",
  forms: ["SSA-561"],
};
const wages: Candidate = {
  title: "Unpaid wages demand letter",
  description: "Write to an employer demanding wages that are owed.",
  jurisdiction: "us/ca",
  authority: "Labor Commissioner",
  forms: [],
};
const registration: Candidate = {
  title: "California vehicle registration renewal",
  description: "Renew the registration of a car or truck with the DMV.",
  jurisdiction: "us/ca",
  authority: "Department of Motor Vehicles",
  forms: [],
};
const garnishment: Candidate = {
  title: "California Wage Garnishment Notice Review",
  description:
    "Preparation checklist for understanding a wage garnishment notice.",
  jurisdiction: "us/ca",
  authority: "California state court",
  forms: [],
};

export const choose: {
  id: string;
  goal: string;
  jurisdiction: string;
  packs: Candidate[];
  expect: number;
}[] = [
  {
    id: "the matching pack",
    goal: "Tell the IRS my new mailing address.",
    jurisdiction: "us",
    packs: [irs, ssa],
    expect: 1,
  },
  {
    id: "second of two",
    goal: "Social Security denied my claim and I want to appeal.",
    jurisdiction: "us",
    packs: [irs, ssa],
    expect: 2,
  },
  {
    // The pack search once returned this pair for sharing the word "form".
    id: "nothing fits: shares only a word",
    goal: "Help a U.S. citizen obtain a green card for her husband.",
    jurisdiction: "us",
    packs: [irs],
    expect: 0,
  },
  {
    id: "nothing fits: same agency, other task",
    goal: "Renew a California driver's license.",
    jurisdiction: "us/ca",
    packs: [wages, registration],
    expect: 0,
  },
  {
    id: "state pack from a city",
    goal: "My employer in Oakland never paid my final paycheck.",
    jurisdiction: "us/ca/alameda",
    packs: [irs, wages],
    expect: 2,
  },
  {
    // The live run's rewording: another name for the same task.
    id: "reworded, authority named differently",
    goal: "What does this wage withholding order from the court mean?",
    jurisdiction: "us/ca",
    packs: [garnishment],
    expect: 1,
  },
];

// --- Research: a process in; notes from the authority's own site out --------

export const research: {
  id: string;
  subject: Subject;
  /** Every source must be on this domain. */
  domain: string;
  /** Patterns the notes must contain. */
  facts: string[];
}[] = [
  {
    id: "dmv renewal",
    subject: {
      process: "driver's license renewal",
      jurisdiction: "us/ca",
      authority: "California Department of Motor Vehicles",
      forms: [],
    },
    domain: "dmv.ca.gov",
    facts: ["online", "mail", "in person|office"],
  },
  {
    id: "oakland parking ticket",
    subject: {
      process: "contest a parking citation",
      jurisdiction: "us/ca/alameda",
      authority: "City of Oakland",
      forms: [],
    },
    domain: "oaklandca.gov",
    facts: ["21"],
  },
  {
    id: "irs address change",
    subject: {
      process: "change of mailing address",
      jurisdiction: "us",
      authority: "Internal Revenue Service",
      forms: ["IRS-8822"],
    },
    domain: "irs.gov",
    facts: ["8822"],
  },
];

// --- Draft: a process and frozen notes in; a checklist and letter out -------
//
// The notes are frozen so a grade moves with the prompt, not with the web.

const DMV_NOTES = `Renewing a California driver's license (dmv.ca.gov).
Ways to renew: online, by mail, or in person at a DMV office.
Online: allowed within 90 days before or 12 months after the expiration date, if you do not need to change your address or personal description, are not applying for a REAL ID for the first time, and are not renewing a commercial license. You need a MyDMV account and payment information. A temporary license is issued at once; the card arrives in about 2 weeks.
By mail: only if your renewal notice says you may. Follow the notice. About 4 weeks.
In person: required if you are 70 or older or the notice says so. Bring the renewal notice or a completed application, give a thumbprint, pass a vision exam, have your photo taken, pay the fee, and take the knowledge test if the notice requires it. A temporary license valid for 60 days is issued.
Fee: the Class C renewal fee is $46. The fee is nonrefundable and the application is valid for 12 months.
The site does not say which payment methods are accepted by mail.
Pages: https://www.dmv.ca.gov/portal/driver-licenses-identification-cards/renew-your-driver-license-dl-or-identification-card-id/ https://www.dmv.ca.gov/portal/driver-licenses-identification-cards/licensing-fees/`;

const OAKLAND_NOTES = `Contesting a City of Oakland parking ticket (oaklandca.gov).
Step 1, the challenge: you must challenge the ticket within 21 days of its issue date. Complete the Contest Form or write a letter explaining why you are challenging the ticket, with your name, mailing address, telephone number and citation number. Submit it with the original ticket and any supporting documents to the Parking and Mobility Assistance Center, online, by mail, by fax or in person. The city reviews it and mails a decision letter. The site does not state a fee for the challenge.
Step 2, the hearing: if the ticket is upheld you may request an Administrative Hearing within 21 days of the date on the decision letter. You must first pay the fine as a deposit, refunded if you win. If you cannot afford it, a Hearing Deposit Waiver form is available. Request the hearing by mail, in person at 270 Frank H. Ogawa Plaza, Oakland, CA 94612, or by telephone at (800) 500-6484.
The site gives no guidance specific to unclear curb markings.
Pages: https://www.oaklandca.gov/Public-Safety-Streets/Parking-Vehicles/Parking-Tickets/Challenge-a-Parking-Ticket https://www.oaklandca.gov/services/request-an-administrative-hearing`;

export const draft: {
  id: string;
  subject: Subject;
  notes: string;
  /** Whether the process calls for a letter the person sends. */
  letter?: boolean;
  maxQuestions?: number;
  /** Patterns a question must match: what the letter can't do without. */
  asks?: string[];
}[] = [
  {
    // Nothing to send: a checklist, and nothing to ask.
    id: "dmv renewal: checklist only",
    subject: {
      process: "driver's license renewal",
      jurisdiction: "us/ca",
      authority: "California Department of Motor Vehicles",
      forms: [],
    },
    notes: DMV_NOTES,
    letter: false,
    maxQuestions: 0,
  },
  {
    // The person writes to the city: a letter, and only what it needs.
    id: "oakland parking: a letter",
    subject: {
      process: "contest a parking citation for an unclear red-zone marking",
      jurisdiction: "us/ca/alameda",
      authority: "City of Oakland",
      forms: [],
    },
    notes: OAKLAND_NOTES,
    letter: true,
    // Name, address, phone, citation number, its date, and the reason.
    maxQuestions: 6,
    asks: ["citation", "reason|why|explain"],
  },
  {
    // The search failed: it may say what to verify, and state no facts.
    id: "no research: invents nothing",
    subject: {
      process: "contest a parking citation",
      jurisdiction: "us/ca/alameda",
      authority: "City of Oakland",
      forms: [],
    },
    notes: "",
  },
];

/** A known-good and a known-bad set of questions, to check the judge itself. */
export const judgeCheck = {
  process: "contest a parking citation",
  good: ["What is your citation number?", "What is your full name?"],
  bad: [
    "What is your address?",
    "What is your current mailing address?",
    "What do the current official instructions request for Form I-130?",
  ],
};

// --- Prefill: what a person said and a form's questions in; answers out -----
//
// Only what they plainly said. A guess is worse than a blank: it ends up in
// their document.

const ADDRESS: Question[] = [
  { key: "fullName", question: "What is your full name?" },
  { key: "oldAddress", question: "What was your old address?" },
  { key: "newAddress", question: "What is your new address?" },
];
const APPEAL: Question[] = [
  { key: "fullName", question: "What is your full name?" },
  {
    key: "denialDate",
    question: "What date is on the denial letter?",
    kind: "date",
  },
  {
    key: "reasonForAppeal",
    question: "Why do you disagree with the decision?",
  },
  {
    key: "wantsRepresentation",
    question: "Do you want a representative? (yes or no)",
  },
];
const WAGES: Question[] = [
  { key: "fullName", question: "What is your full name?" },
  { key: "employer", question: "Who was your employer?" },
  {
    key: "amountOwed",
    question: "How much are you owed, in dollars?",
    kind: "number",
  },
  {
    key: "lastWorkDate",
    question: "What was your last day of work?",
    kind: "date",
  },
];

export const prefill: ({
  id: string;
  questions: Question[];
  said: string[];
} & PrefillExpectation)[] = [
  {
    id: "two of three stated",
    questions: ADDRESS,
    said: [
      "I moved from 1 Old Road, Oakland to 2 New Street, Berkeley and need to tell the IRS.",
    ],
    has: { oldAddress: "1 Old Road", newAddress: "2 New Street" },
    absent: ["fullName"],
  },
  {
    id: "nothing stated",
    questions: APPEAL,
    said: ["Social Security denied my disability claim and I want to appeal."],
    has: {},
    absent: ["fullName", "denialDate", "wantsRepresentation"],
  },
  {
    id: "a date and an amount, in words",
    questions: WAGES,
    said: [
      "My employer, Acme Corp, owes me $6,200.",
      "My last day there was October 3, 2026.",
    ],
    has: {
      employer: "Acme",
      amountOwed: "^6200(\\.00)?$",
      lastWorkDate: "^2026-10-03$",
    },
    absent: ["fullName"],
  },
  {
    id: "across messages, with a tempting gap",
    questions: APPEAL,
    said: [
      "Hi, I'm Ada Lovelace.",
      "I got a denial letter from Social Security last month.",
    ],
    has: { fullName: "Ada Lovelace" },
    // "Last month" is not a date they stated.
    absent: ["denialDate", "wantsRepresentation"],
  },
  {
    id: "someone else's details",
    questions: ADDRESS,
    said: [
      "My sister Grace Hopper lives at 9 Elm Street. I need to change my own address with the IRS.",
    ],
    has: {},
    absent: ["fullName", "oldAddress", "newAddress"],
  },
];

// --- Search: the pack library, no model -------------------------------------
//
// Against the fixture packs (`dev:seed`). `expect` is a title that must be
// among the candidates, or null when nothing should be found.

export const search: {
  id: string;
  jurisdiction: string;
  terms: string;
  expect: string | null;
}[] = [
  {
    id: "state pack from a county",
    jurisdiction: "us/ca/alameda",
    terms: "my employer owes me my final paycheck",
    expect: "Unpaid wages demand letter",
  },
  {
    id: "federal pack from a state",
    jurisdiction: "us/ca",
    terms: "appeal a Social Security denial",
    expect: "Social Security appeal (reconsideration)",
  },
  {
    id: "by form number",
    jurisdiction: "us",
    terms: "form 8822",
    expect: "IRS change of address (Form 8822)",
  },
  {
    id: "another state's pack isn't found",
    jurisdiction: "us/tx",
    terms: "unpaid wages demand letter",
    expect: null,
  },
  {
    id: "nothing for an unrelated task",
    jurisdiction: "us",
    terms: "green card husband",
    expect: null,
  },
];

// --- Outcome: stage 1 end to end, on a real case ----------------------------

export const outcome: { id: string; goal: string; expect: Outcome }[] = [
  {
    id: "a saved pack",
    goal: "I moved and need to tell the IRS my new address.",
    expect: "pack",
  },
  {
    id: "a draft",
    goal: "Contest a parking ticket I got in Oakland, California.",
    expect: "draft",
  },
  {
    id: "a referral",
    goal: "Should I sue my landlord in California for keeping my deposit?",
    expect: "referral",
  },
  {
    id: "a clarifying question",
    goal: "I got a letter.",
    expect: "clarification",
  },
];

// --- Pipeline: a whole case, played by the autopilot ------------------------

export const pipeline: {
  id: string;
  /** Start on this fixture pack (no model), or from a goal (with models). */
  start: { pack: "irs8822" | "ssaAppeal" | "wageClaim" } | { goal: string };
  pilot: Pick<PilotOptions, "referral" | "consent">;
  expect: PipelineExpectation;
}[] = [
  {
    id: "a form, delivered by mail",
    start: { pack: "irs8822" },
    pilot: { referral: "avoid", consent: "decline" },
    expect: { delivery: "mail", referral: null },
  },
  {
    id: "referral offered and shared",
    start: { pack: "ssaAppeal" },
    pilot: { referral: "trigger", consent: "share" },
    expect: { delivery: "online", referral: "shared" },
  },
  {
    id: "referral offered and declined",
    start: { pack: "wageClaim" },
    pilot: { referral: "trigger", consent: "decline" },
    // The letter is built from the answers, and the required file is in.
    expect: { referral: "declined", letterHas: "Analytical Engines Ltd" },
  },
  {
    id: "referral check not met: none offered",
    start: { pack: "wageClaim" },
    pilot: { referral: "avoid", consent: "share" },
    expect: { delivery: null, referral: null },
  },
  {
    // Every stage, with the models: goal, saved pack, answers, approval.
    id: "from a goal to a delivered form",
    start: { goal: "I moved and need to tell the IRS my new address." },
    pilot: { referral: "avoid", consent: "decline" },
    expect: { delivery: "mail" },
  },
];
