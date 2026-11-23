// The eval cases, one list per slice. They live in code so they're typed and
// reviewed like any other change; results live in the tables.
//
// A slice is one model call run on its own with fixed inputs ("intake",
// "request", "choose", "research", "forms", "draft", "suggest", "tailor", "address"), the pack search with no model
// ("search"), stage 1 end to end ("outcome"), or a whole case ("pipeline").
import type { PilotOptions } from "../autopilot";
import type { Candidate, Question, Subject } from "../case/agents";
import type { TargetBrief } from "../forms/agents";
import type {
  AddressExpectation,
  Outcome,
  PipelineExpectation,
  SuggestExpectation,
  TargetExpectation,
  TailorExpectation,
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
  // The opening messages of easy-gov's legal-intake corpus, as people wrote
  // them. Each says who the packet is for: the person themselves ("prepare
  // the claim") is a process, and a lawyer or other practitioner ("for
  // employment counsel") is a referral. A place is expected only where the
  // message settles one: a federal agency is "us".
  {
    id: "corpus: ssdi-reconsideration-001",
    goal: "SSA denied my disability claim. Please identify what you need and prepare the correct appeal packet.",
    kinds: ["process"],
    jurisdictions: ["us"],
  },
  {
    id: "corpus: va-initial-knee-claim-001",
    goal: "I injured my knee in the Army and still receive treatment. Please identify what you need and prepare the initial VA disability claim.",
    kinds: ["process"],
    jurisdictions: ["us"],
  },
  {
    id: "corpus: qui-tam-medicare-billing-001",
    goal: "My employer billed Medicare for tests that were not performed. Please identify what you need for a lawyer to assess this before I disclose anything else.",
    kinds: ["referral"],
  },
  {
    id: "corpus: ca-medmal-surgery-001",
    goal: "I needed emergency corrective surgery two days after an operation. Please identify what you need for a California malpractice lawyer.",
    kinds: ["referral"],
    jurisdictions: ["us/ca"],
  },
  {
    id: "corpus: ca-insurance-wildfire-001",
    goal: "My homeowners insurer denied my wildfire claim. Please identify what you need for legal review.",
    // It names no place, so asking where is right too.
    kinds: ["referral", "unclear"],
  },
  {
    id: "corpus: ca-personal-injury-crash-001",
    goal: "Another driver rear-ended me in Los Angeles. Please identify what you need for a lawyer to review the claim.",
    kinds: ["referral"],
  },
  {
    id: "corpus: ca-class-action-fee-001",
    goal: "A company charged the same undisclosed fee to many California customers. Please identify what you need for class-action counsel to assess it.",
    kinds: ["referral"],
    jurisdictions: ["us/ca"],
  },
  {
    id: "corpus: ca-wage-paga-001",
    goal: "My employer's policy omits overtime and meal-break premiums. Please identify what you need for employment counsel.",
    kinds: ["referral"],
  },
  {
    id: "corpus: ca-workers-comp-back-001",
    goal: "I hurt my back lifting inventory at work and told my supervisor. Please identify what you need to prepare the employee claim and evidence packet.",
    kinds: ["process", "unclear"],
  },
  {
    id: "corpus: uscis-i485-rfe-i864-001",
    goal: "USCIS sent an RFE on my I-485 for missing financial sponsorship evidence. Please identify what you need for an authorized immigration practitioner.",
    kinds: ["referral"],
    jurisdictions: ["us"],
  },
  {
    id: "corpus: irs-cp90-cdp-001",
    goal: "I received an IRS CP90 final notice of intent to levy. Please identify what you need for the correct hearing-request packet and tax-professional review.",
    kinds: ["process"],
    jurisdictions: ["us"],
  },
  {
    id: "corpus: ca-bankruptcy-intake-001",
    goal: "I have credit-card and medical debt plus a wage garnishment. Please identify what you need for a bankruptcy lawyer in Los Angeles.",
    kinds: ["referral"],
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
    // DL 410 FO is the renew-by-mail form: the site doesn't link it from
    // the renewal page, so a general search tends to miss it.
    facts: ["online", "mail", "in person|office", "DL.?410"],
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

// --- Forms: a goal in; the official forms it needs, each fetched, out -------
//
// What a person says, and the official forms the finished packet should
// hold. Most are the cases of easy-gov's legal-intake corpus that expect an
// official form (`packages/backend/evals/discovery/legal-intake-smoke-cases.json`
// there, checked 2026-07-22), with the opening message as the goal. The
// list isn't every form a case could need: a form found beyond it is
// recorded, and isn't a failure.
//
// Two of that corpus's cases are left out: a car crash and a wage claim with
// a lawyer's packet. The app reads both as matters for a lawyer and offers a
// referral, so it never researches forms for them, and here they only
// measured how the request was read. One message there never says where the
// person is (the corpus learns it from an uploaded notice), so the state is
// added: without it the right answer is a question, not a form.

export const forms: {
  id: string;
  goal: string;
  /** The forms that must come back. `url` is where each was last published. */
  expect: { code: string; url: string }[];
}[] = [
  {
    id: "ssdi-reconsideration-001",
    goal: "SSA denied my disability claim. Please identify what you need and prepare the correct appeal packet.",
    expect: [
      { code: "SSA-561", url: "https://www.ssa.gov/forms/ssa-561-u2.pdf" },
      { code: "SSA-3441", url: "https://www.ssa.gov/forms/ssa-3441.pdf" },
      { code: "SSA-827", url: "https://www.ssa.gov/forms/ssa-827.pdf" },
    ],
  },
  {
    id: "va-initial-knee-claim-001",
    goal: "I injured my knee in the Army and still receive treatment. Please identify what you need and prepare the initial VA disability claim.",
    expect: [
      {
        code: "VA-21-526EZ",
        url: "https://www.vba.va.gov/pubs/forms/VBA-21-526EZ-ARE.pdf",
      },
    ],
  },
  {
    id: "ca-workers-comp-back-001",
    goal: "I work in California. I hurt my back lifting inventory at work and told my supervisor. Please identify what you need to prepare the employee claim and evidence packet.",
    expect: [{ code: "DWC-1", url: "https://www.dir.ca.gov/dwc/DWCForm1.pdf" }],
  },
  {
    id: "uscis-i485-rfe-i864-001",
    goal: "USCIS sent an RFE on my I-485 for missing financial sponsorship evidence. Please identify what you need for an authorized immigration practitioner.",
    expect: [
      {
        code: "USCIS-I-864",
        url: "https://www.uscis.gov/sites/default/files/document/forms/i-864.pdf",
      },
    ],
  },
  {
    id: "irs-cp90-cdp-001",
    goal: "I received an IRS CP90 final notice of intent to levy. Please identify what you need for the correct hearing-request packet and tax-professional review.",
    expect: [
      {
        code: "IRS-FORM-12153",
        url: "https://www.irs.gov/pub/irs-pdf/f12153.pdf",
      },
    ],
  },
  {
    id: "ca-dl-renewal",
    goal: "I need to renew my California driver's license.",
    expect: [
      {
        code: "DL-410-FO",
        url: "https://www.dmv.ca.gov/portal/uploads/2025/12/DL-410-FO-R12-2025-ASB-WWW.pdf",
      },
    ],
  },
  {
    id: "irs-address-change",
    goal: "I moved and need to tell the IRS my new address.",
    expect: [
      { code: "IRS-8822", url: "https://www.irs.gov/pub/irs-pdf/f8822.pdf" },
    ],
  },
  // The cases below were each checked on 2026-11-21 against the authority's
  // own page: the task, the code the form prints, and the address the page
  // links. They are chosen for how differently the authorities publish.

  // https://www.cms.gov/medicare/cms-forms/cms-forms/cms-forms-items/cms017339
  // links the file. Checked 2026-11-21.
  {
    id: "medicare-part-b-enrollment",
    goal: "I'm 67 and already have Medicare Part A, but I never took Part B. It's the general enrollment period and I want to sign up for Part B now.",
    expect: [
      {
        code: "CMS-40B",
        url: "https://www.cms.gov/medicare/cms-forms/cms-forms/downloads/cms40b-e.pdf",
      },
    ],
  },
  // https://www.archives.gov/veterans/military-service-records links
  // /research/order/standard-form-180.pdf, which redirects to GSA's page
  // https://www.gsa.gov/reference/forms/request-pertaining-to-military-records,
  // and that page links the file. Checked 2026-11-21.
  {
    id: "nara-military-records-by-mail",
    goal: "I'm a veteran and lost my discharge papers. I want to request a copy of my military service records from the National Archives by mail.",
    expect: [
      {
        code: "SF-180",
        url: "https://www.gsa.gov/system/files/2026-07/SF180-26a.pdf",
      },
    ],
  },
  // https://www.esd.whs.mil/Directives/forms/dd0001_0499/DD293/ links the
  // file, from the DoD forms list at
  // https://www.esd.whs.mil/Directives/forms/dd0001_0499/. Checked 2026-11-21.
  {
    id: "dod-discharge-review",
    goal: "I left the Army six years ago with a general discharge. I want to apply to the Discharge Review Board to have my discharge reviewed and upgraded.",
    expect: [
      {
        code: "DD-293",
        url: "https://www.esd.whs.mil/portals/54/documents/dd/forms/dd/dd0293.pdf",
      },
    ],
  },
  // https://dmv.ny.gov/records/change-your-address links the file.
  // Checked 2026-11-21.
  {
    id: "ny-dmv-address-change",
    goal: "I moved within New York State and need to tell the DMV my new address for my driver license and car registration, by mail.",
    expect: [{ code: "MV-232", url: "https://dmv.ny.gov/forms/mv232.pdf" }],
  },
  // https://www.pa.gov/services/dmv/replace-a-drivers-license links the file
  // under its mail-in process. Checked 2026-11-21.
  {
    id: "pa-replace-license-by-mail",
    goal: "I lost my Pennsylvania driver's license. It isn't a commercial license and hasn't expired, and I want to replace it by mail.",
    expect: [
      {
        code: "DL-80",
        url: "https://www.pa.gov/content/dam/copapwp-pagov/en/penndot/documents/public/dvspubsforms/bdl/bdl-form/dl-80.pdf",
      },
    ],
  },
  // https://dol.wa.gov/vehicles-and-boats/vehicles/vehicle-registration/vehicle-title/replace-lost-title-or-registration
  // links the form finder (https://dol.wa.gov/forms/view?...field_form_id_value=420040),
  // which links this address; it has no ".pdf" and redirects to
  // /forms/view/420040/download?inline, a PDF. Checked 2026-11-21.
  {
    id: "wa-replace-lost-title",
    goal: "I live in Washington State and lost the title to my car. I own it outright and want a replacement title.",
    expect: [
      { code: "TD-420-040", url: "https://dol.wa.gov/forms/view/420040" },
    ],
  },
  // https://www.oregon.gov/odot/DMV/pages/vehicle/titlereg.aspx links the
  // file under "Duplicate Title (Title is Lost)". Checked 2026-11-21.
  {
    id: "or-replace-lost-title",
    goal: "I lost the title to my car in Oregon. Nothing about the ownership has changed and I need a duplicate title.",
    expect: [
      {
        code: "735-515",
        url: "https://www.oregon.gov/odot/Forms/DMV/515fill.pdf",
      },
    ],
  },
  // https://selfhelp.courts.ca.gov/fee-waiver links both files: the request,
  // and the order whose item 1 the person fills out. The first address
  // redirects to courts.ca.gov/sites/default/files/courts/default/2024-11/fw001.pdf.
  // Checked 2026-11-21.
  {
    id: "ca-court-fee-waiver",
    goal: "I'm filing a civil case in California superior court and can't afford the filing fee. I receive CalFresh. I want to ask the court to waive its fees.",
    expect: [
      {
        code: "FW-001",
        url: "https://courts.ca.gov/sites/default/files/courts/default/2024-11/fw001.pdf",
      },
      {
        code: "FW-003",
        url: "https://courts.ca.gov/sites/default/files/courts/default/2024-11/fw003.pdf",
      },
    ],
  },
  // https://www.mass.gov/info-details/checklist-of-forms-change-of-name-for-adult
  // lists both as required, each on its own page, which links the file:
  // .../probate-and-family-court-petition-to-change-name-of-adult-cjp-27 and
  // .../probate-and-family-court-court-activity-record-information-and-warrant-management-system-release-request-form-cjp-34.
  // The addresses end in "/download", not ".pdf". Checked 2026-11-21.
  {
    id: "ma-adult-name-change",
    goal: "I'm an adult living in Massachusetts and want to legally change my name through the Probate and Family Court.",
    expect: [
      {
        code: "CJP-27",
        url: "https://www.mass.gov/doc/petition-to-change-name-of-adult-cjp-27/download",
      },
      {
        code: "CJP-34",
        url: "https://www.mass.gov/doc/court-activity-record-information-and-warrant-management-system-release-request-form-cjp-34/download",
      },
    ],
  },
  // https://www.sdarcc.gov/content/arcc/home/divisions/assessor/property-tax-savings/homeowner-exemption.html
  // and the Assessor's forms page
  // https://www.sdarcc.gov/content/arcc/home/divisions/assessor/assessor-forms.html
  // link the file. Checked 2026-11-21.
  {
    id: "san-diego-homeowners-exemption",
    goal: "I bought a house in San Diego County, California and live in it as my main home. I want to claim the homeowners' property tax exemption with the county assessor.",
    expect: [
      {
        code: "BOE-266",
        url: "https://www.sdarcc.gov/content/dam/arcc/assessor/forms/property-tax-exemption-and-exclusion-forms/266HOXCLAIM.pdf",
      },
    ],
  },
  // https://www.nyc.gov/site/finance/vehicles/dispute-appeal-hearing.page
  // names the application and links the forms page
  // https://www.nyc.gov/site/finance/vehicles/forms-individual.page, which
  // links the file. Checked 2026-11-21.
  {
    id: "nyc-parking-ticket-appeal",
    goal: "A judge found me guilty at my New York City parking ticket hearing two weeks ago. I want to appeal that decision to the Department of Finance.",
    expect: [
      {
        code: "PVO-0100",
        url: "https://www.nyc.gov/assets/finance/downloads/pdf/adjudication/pvo-0100.pdf",
      },
    ],
  },
];

// --- World: the forms cases, outside the US ---------------------------------
//
// The same step as "forms", for countries with no .gov register: each file
// was reached on 2026-11-21 by following links from the country's national
// portal (see forms/VOUCHING.md), and checked to be a PDF.

export const world: typeof forms = [
  // gov.uk → HMRC → Self Assessment tax return.
  {
    id: "uk-self-assessment-paper",
    goal: "I'm self-employed in England and want to file my Self Assessment tax return on paper this year, not online.",
    expect: [
      {
        code: "SA100",
        url: "https://assets.publishing.service.gov.uk/media/69c14d07cfa346b9d4704a8d/SA100-2026.pdf",
      },
    ],
  },
  // gov.uk → DVLA → apply for a vehicle log book.
  {
    id: "uk-replace-logbook",
    goal: "I live in the UK and lost my car's log book (V5C). I want to apply for a replacement by post.",
    expect: [
      {
        code: "V62",
        url: "https://assets.publishing.service.gov.uk/media/691afc5a0dcbf6343e9a2883/v62-application-for-a-registration-certificate.pdf",
      },
    ],
  },
  // canada.ca → CRA forms → adjustment request.
  {
    id: "ca-change-tax-return",
    goal: "I live in Canada and found a mistake on my income tax return after it was assessed. I want to ask the CRA to change it, by mail.",
    expect: [
      {
        code: "T1-ADJ",
        url: "https://www.canada.ca/content/dam/cra-arc/formspubs/pbg/t1-adj/t1-adj-23e.pdf",
      },
    ],
  },
  // canada.ca → IRCC → visitor visa application.
  {
    id: "ca-visitor-visa-paper",
    goal: "I'm outside Canada and want to visit as a tourist. I need to apply for a Canadian visitor visa on paper.",
    expect: [
      {
        code: "IMM 5257",
        url: "https://www.canada.ca/content/dam/ircc/documents/pdf/english/kits/forms/imm5257/01-11-2026/imm5257e.pdf",
      },
    ],
  },
  // gov.ie → Revenue → income tax return for routine tax affairs.
  {
    id: "ie-paper-tax-return",
    goal: "I'm an employee in Ireland with simple tax affairs. I can't use Revenue's online service and want to file my 2025 income tax return on paper, claiming medical expenses.",
    expect: [
      {
        code: "Form 12S",
        url: "https://www.revenue.ie/en/self-assessment-and-self-employment/documents/form-12s.pdf",
      },
    ],
  },
  // govt.nz → Inland Revenue → individual income tax return.
  {
    id: "nz-individual-tax-return",
    goal: "I live in New Zealand and had self-employed income this year. I need to file my individual income tax return on paper.",
    expect: [
      {
        code: "IR3",
        url: "https://www.ird.govt.nz/-/media/project/ir/home/documents/forms-and-guides/ir1---ir99/ir3/ir3-2026.pdf",
      },
    ],
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
  /** Whether it should ask about the person's situation, to cut steps by. */
  tailors?: boolean;
  /** Who the person is and how to reach them come from the profile's keys. */
  usesProfile?: boolean;
}[] = [
  {
    // Nothing to send. Three routes, so it asks which is the person's.
    id: "dmv renewal: checklist only",
    subject: {
      process: "driver's license renewal",
      jurisdiction: "us/ca",
      authority: "California Department of Motor Vehicles",
      forms: [],
    },
    notes: DMV_NOTES,
    letter: false,
    maxQuestions: 3,
    tailors: true,
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
    // Name, address, phone, citation number, its date and the reason, plus
    // up to three about where they are in the process.
    maxQuestions: 9,
    asks: ["citation", "reason|why|explain"],
    usesProfile: true,
  },
  {
    // The search failed: it may say what to verify, and state no facts.
    // With no knowing what the authority wants, no letter and no questions.
    id: "no research: invents nothing",
    subject: {
      process: "contest a parking citation",
      jurisdiction: "us/ca/alameda",
      authority: "City of Oakland",
      forms: [],
    },
    notes: "",
    letter: false,
    tailors: false,
    maxQuestions: 0,
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

// --- Suggest: what a person said and a form's questions in; answers out -----
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

export const suggest: ({
  id: string;
  questions: Question[];
  said: string[];
} & SuggestExpectation)[] = [
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

// --- Tailor: a checklist and a situation in; the steps that apply out -------

const DMV_STEPS = [
  "Check your renewal notice to see which ways of renewing are open to you.",
  "To renew online, sign in to your MyDMV account, complete the renewal and pay the $46 fee.",
  "To renew by mail, follow the instructions on your renewal notice and allow about 4 weeks.",
  "To renew in person, bring your renewal notice to a DMV office, give a thumbprint, pass a vision exam and have your photo taken.",
  "If you are 70 or older, you must renew in person.",
  "Wait for the new card to arrive by mail.",
];
const OAKLAND_STEPS = [
  "Challenge the ticket within 21 days of its issue date.",
  "Send the Contest Form or a letter with the original ticket to the Parking and Mobility Assistance Center.",
  "Wait for the city's decision letter.",
  "If the ticket was upheld, request an Administrative Hearing within 21 days of the decision letter.",
  "Before the hearing, pay the fine as a deposit, which is refunded if you win.",
];

export const tailor: ({
  id: string;
  checklist: string[];
  situation: { question: string; answer: string }[];
} & TailorExpectation)[] = [
  {
    id: "one route of three",
    checklist: DMV_STEPS,
    situation: [
      { question: "How do you want to renew?", answer: "online" },
      { question: "Are you 70 or older?", answer: "no" },
    ],
    keep: [1, 2, 6],
    drop: [3, 4, 5],
  },
  {
    id: "an answer that forces a route",
    checklist: DMV_STEPS,
    situation: [{ question: "Are you 70 or older?", answer: "yes" }],
    keep: [4, 5, 6],
    drop: [2, 3],
  },
  {
    id: "a later stage not reached yet",
    checklist: OAKLAND_STEPS,
    situation: [
      { question: "Has the city already upheld your ticket?", answer: "no" },
    ],
    // The hearing may still come: its steps aren't ruled out, only later.
    keep: [1, 2, 3],
    drop: [],
  },
  {
    id: "already at the later stage",
    checklist: OAKLAND_STEPS,
    situation: [
      { question: "Has the city already upheld your ticket?", answer: "yes" },
    ],
    keep: [4, 5],
    drop: [1, 2],
  },
  {
    id: "an answer that says nothing",
    checklist: DMV_STEPS,
    situation: [{ question: "How do you want to renew?", answer: "not sure" }],
    keep: [1, 2, 3, 4, 6],
    drop: [],
  },
];

// --- Address: one line of text in; its parts out ----------------------------
//
// Only what's written. A ZIP it wasn't given must stay empty: a made-up one
// would go on an envelope.

export const address: ({ id: string; text: string } & AddressExpectation)[] = [
  {
    id: "the usual shape",
    text: "2 New Street, Berkeley, CA 94704",
    parts: {
      street: "2 New Street",
      city: "Berkeley",
      state: "CA",
      postalCode: "94704",
      country: "US",
    },
    blank: ["unitNumber", "careOf"],
  },
  {
    id: "a unit, and the state spelled out",
    text: "1600 Shattuck Avenue Apt 4B Berkeley California 94709-1234",
    parts: {
      street: "1600 Shattuck Avenue",
      unitNumber: "4B",
      city: "Berkeley",
      state: "CA",
      postalCode: "94709-1234",
    },
  },
  {
    id: "no ZIP given",
    text: "270 Frank H. Ogawa Plaza, Oakland, CA",
    parts: { street: "270 Frank H. Ogawa Plaza", city: "Oakland", state: "CA" },
    blank: ["postalCode"],
  },
  {
    id: "care of someone",
    text: "c/o Grace Hopper, 9 Elm St, Arlington, VA 22201",
    parts: {
      careOf: "Grace Hopper",
      street: "9 Elm St",
      city: "Arlington",
      state: "VA",
      postalCode: "22201",
    },
  },
  {
    id: "not an address",
    text: "I moved last month and need to tell the IRS.",
    parts: null,
  },
];

// --- Mapping: a form's places in; what goes in each out ---------------------
//
// The labels are the words printed on the real forms. A mapping is reviewed
// by a person before it fills anything; this measures how good the draft is.

export const mapping: {
  id: string;
  title: string;
  targets: TargetBrief[];
  expect: Record<string, TargetExpectation>;
}[] = [
  {
    id: "irs 8822: whole lines, and other people's boxes",
    title: "IRS-8822 Change of Address",
    targets: [
      {
        id: "t1",
        kind: "text",
        label: "3a Your name (first name, initial, and last name)",
      },
      { id: "t2", kind: "text", label: "3b Your social security number" },
      {
        id: "t3",
        kind: "text",
        label: "4a Spouse’s name (first name, initial, and last name)",
      },
      { id: "t4", kind: "text", label: "4b Spouse’s social security number" },
      {
        id: "t5",
        kind: "text",
        label:
          "6a Your old address (no., street, apt. no., city or town, state, and ZIP code). If a P.O. box, see instructions.",
      },
      {
        id: "t6",
        kind: "text",
        label:
          "6b Spouse’s old address, if different from line 6a (no., street, apt. no., city or town, state, and ZIP code).",
      },
      {
        id: "t7",
        kind: "text",
        label:
          "7 New address (no., street, apt. no., city or town, state, and ZIP code). If a P.O. box, see instructions.",
      },
      {
        id: "t8",
        kind: "text",
        label: "Daytime telephone number of person to contact (optional)",
      },
      { id: "t9", kind: "text", label: "Your signature" },
      {
        id: "t11",
        kind: "check",
        label:
          "Check all boxes this change affects: 1 Individual income tax returns (Forms 1040, 1040-SR, 1040-NR, etc.)",
      },
      {
        id: "t12",
        kind: "check",
        label:
          "2 Gift, estate, or generation-skipping transfer tax returns (Forms 706, 709, etc.)",
      },
      {
        id: "t10",
        kind: "text",
        label:
          "Signature of representative, executor, administrator/if applicable Date",
      },
    ],
    expect: {
      t1: { readings: ["fullName"] },
      t2: { left: true },
      t3: { notProfile: true },
      t4: { left: true },
      t5: { readings: ["homeAddressLine", "mailingAddressLine"] },
      t6: { notProfile: true },
      t7: { caseInput: true },
      // t8, "person to contact", may or may not be the filer: a reviewer's
      // call, so the draft isn't graded on it.
      t9: { left: true },
      t10: { left: true },
      // "Check all boxes": one question, two choices, several may apply.
      t11: { group: "returns", many: true },
      t12: { group: "returns", many: true },
    },
  },
  {
    id: "a form cut into boxes",
    title: "Request for a certified copy",
    targets: [
      { id: "t1", kind: "text", label: "Applicant's first name" },
      { id: "t2", kind: "text", label: "M.I." },
      { id: "t3", kind: "text", label: "Last name" },
      { id: "t4", kind: "text", label: "Mailing address: number and street" },
      { id: "t5", kind: "text", label: "Apt. or unit no." },
      { id: "t6", kind: "text", label: "City" },
      { id: "t7", kind: "text", label: "State" },
      { id: "t8", kind: "text", label: "ZIP code" },
      { id: "t9", kind: "text", label: "Email address" },
      { id: "t10", kind: "text", label: "Date of birth" },
      { id: "t11", kind: "text", label: "Number of copies requested" },
      { id: "t12", kind: "text", label: "For office use only: receipt no." },
      { id: "t13", kind: "check", label: "Type of copy: Certified" },
      { id: "t14", kind: "check", label: "Informational" },
      {
        id: "t15",
        kind: "check",
        label: "I am the person named on the record",
      },
    ],
    expect: {
      t1: { readings: ["givenName"] },
      // An initial, never a whole middle name.
      t2: { readings: ["middleInitial"] },
      t3: { readings: ["familyName"] },
      t4: { readings: ["mailingStreetOnly", "mailingStreet"] },
      t5: { readings: ["mailingUnit"] },
      t6: { readings: ["mailingCity"] },
      t7: { readings: ["mailingState"] },
      t8: { readings: ["mailingZip"] },
      t9: { readings: ["email"] },
      t10: { readings: ["birthDate"] },
      t11: { caseInput: true },
      t12: { notProfile: true },
      // Alternatives: one question, pick one.
      t13: { group: "copyType", many: false },
      t14: { group: "copyType", many: false },
      // A box on its own: a yes or no.
      t15: { caseInput: true },
    },
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

/**
 * IRS Form 8822 and a reviewed mapping for it, by the words printed beside
 * each place. This is what a person signs off on the forms page.
 */
export const FORM_8822 = {
  code: "IRS-8822",
  title: "Change of Address",
  jurisdiction: "us",
  sourceUrl: "https://www.irs.gov/pub/irs-pdf/f8822.pdf",
  delivery: "mail" as const,
  mapping: [
    {
      label: "^Individual income tax returns",
      entry: {
        input: "returnTypes",
        includes: "individual",
        question: "Which returns does this change affect?",
      },
    },
    {
      label: "^Gift, estate",
      entry: { input: "returnTypes", includes: "gift" },
    },
    { label: "^3a Your name", entry: { input: "fullName" } },
    {
      label: "^3b Your social security",
      entry: {
        leave: {
          why: "confidential" as const,
          note: "Your Social Security number, on line 3b.",
        },
      },
    },
    { label: "^6a Your old address", entry: { input: "homeAddressLine" } },
    {
      label: "^7 New address",
      entry: { input: "newAddress", question: "What is your new address?" },
    },
    {
      label: "^Signature of representative",
      entry: {
        leave: { why: "signature" as const, note: "Sign and date the form." },
      },
    },
  ],
};

// --- Pipeline: a whole case, played by the autopilot ------------------------

export const pipeline: {
  id: string;
  /** Start on this fixture pack (no model), or from a goal (with models). */
  start:
    | { pack: "irs8822" | "ssaAppeal" | "wageClaim" }
    | { goal: string }
    /** A real form: fetched from its source, mapped as below, then filled. */
    | { form: typeof FORM_8822 };
  pilot: Pick<PilotOptions, "referral" | "consent">;
  expect: PipelineExpectation;
}[] = [
  {
    // The official PDF: fetched from irs.gov now, filled from the answers,
    // and read back from the file.
    id: "a real form, fetched and filled",
    start: { form: FORM_8822 },
    pilot: { referral: "avoid", consent: "reject" },
    expect: {
      delivery: "mail",
      form: {
        inputs: ["fullName", "homeAddressLine", "newAddress"],
        // "Which returns": the autopilot picks the first choice.
        ticked: 1,
        toComplete: 2,
      },
    },
  },
  {
    id: "a form, delivered by mail",
    start: { pack: "irs8822" },
    pilot: { referral: "avoid", consent: "reject" },
    expect: { delivery: "mail", referral: null },
  },
  {
    id: "referral offered and shared",
    start: { pack: "ssaAppeal" },
    pilot: { referral: "trigger", consent: "share" },
    expect: { delivery: "online", referral: "shared" },
  },
  {
    id: "referral offered and rejected",
    start: { pack: "wageClaim" },
    pilot: { referral: "trigger", consent: "reject" },
    // The letter is built from the answers, and the required file is in.
    expect: { referral: "rejected", letterHas: "Analytical Engines Ltd" },
  },
  {
    id: "referral check not met: none offered",
    start: { pack: "wageClaim" },
    pilot: { referral: "avoid", consent: "share" },
    expect: { delivery: null, referral: null },
  },
  {
    // Every stage, with the models: goal, saved pack, answers, review.
    id: "from a goal to a delivered form",
    start: { goal: "I moved and need to tell the IRS my new address." },
    pilot: { referral: "avoid", consent: "reject" },
    expect: { delivery: "mail" },
  },
];
