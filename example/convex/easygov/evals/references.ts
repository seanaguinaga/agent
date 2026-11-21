// Reference answers for forms cases: what a correct answer says, written by
// a reviewer from the authority's own pages and the files themselves, for a
// judge to compare a trial's output with. Only what was read is stated; a
// case not here has no reference yet.

export type Reference = {
  /** The day the pages and files were read. */
  checked: string;
  forms: {
    code: string;
    /** The edition the file prints, as printed. */
    edition?: string;
    /** The file, and the official page that links it as this form. */
    file: string;
    linkedFrom: string;
    /** What a correct answer has to get right about this form. */
    note?: string;
  }[];
  /** What the authority's page says that the person needs to be told. */
  facts: string[];
  /** Mistakes a plausible answer makes. */
  traps: string[];
};

export const references: Record<string, Reference> = {
  "ssdi-reconsideration-001": {
    checked: "2026-11-21",
    forms: [
      {
        code: "SSA-561",
        edition: "08-2025",
        file: "https://www.ssa.gov/forms/ssa-561-u2.pdf",
        linkedFrom: "https://www.ssa.gov/forms/ssa-561.html",
        note:
          "Formerly SSA-561-U2. The file name kept the old code; the form " +
          'prints "Form SSA-561 (08-2025)" and "Discontinue Prior Editions".',
      },
      {
        code: "SSA-3441",
        file: "https://www.ssa.gov/forms/ssa-3441.pdf",
        linkedFrom: "https://www.ssa.gov/forms/ssa-3441.html",
        note: "Needed when the decision appealed was a medical one.",
      },
      {
        code: "SSA-827",
        file: "https://www.ssa.gov/forms/ssa-827.pdf",
        linkedFrom: "https://www.ssa.gov/forms/ssa-3441.html",
        note: "Needed when the decision appealed was a medical one.",
      },
    ],
    facts: [
      "A reconsideration has to be requested within 60 days of receiving the decision.",
      "It can be requested online instead of on paper.",
      "The decision letter says whether to ask for a reconsideration or a hearing.",
      "Completed forms go to the local Social Security office.",
    ],
    traps: [
      "Using /forms/ssa-561.pdf: it is the 12-2016 SSA-561-U2, which the 2025 " +
        "edition discontinues. SSA's own SSA-3441 page still links it.",
      "Giving HA-501: that requests a hearing, the step after reconsideration.",
    ],
  },
  "ny-dmv-address-change": {
    checked: "2026-11-21",
    forms: [
      {
        code: "MV-232",
        edition: "2/26",
        file: "https://dmv.ny.gov/forms/mv232.pdf",
        linkedFrom: "https://dmv.ny.gov/records/change-your-address",
        note:
          'The page links it as "Address Change (PDF)" under "At a DMV ' +
          'Office"; the code is printed mid-page, "MV-232 (2/26)".',
      },
    ],
    facts: [
      "The address can be changed online instead.",
      "DMV has to be told within 10 days of a permanent change of address.",
    ],
    traps: ["Rejecting the file because its first lines don't print the code."],
  },
  "ma-adult-name-change": {
    checked: "2026-11-21",
    forms: [
      {
        code: "CJP 27",
        edition: "12/11/25",
        file: "https://www.mass.gov/doc/petition-to-change-name-of-adult-cjp-27/download",
        linkedFrom:
          "https://www.mass.gov/info-details/probate-and-family-court-petition-to-change-name-of-adult-cjp-27",
      },
      {
        code: "CJP 34",
        edition: "5/1/24",
        file: "https://www.mass.gov/doc/court-activity-record-information-and-warrant-management-system-release-request-form-cjp-34/download",
        linkedFrom:
          "https://www.mass.gov/info-details/probate-and-family-court-uniform-guide-to-filings",
        note: "Listed with CJP 27 as required at the initial filing.",
      },
    ],
    facts: ["The petition is filed in the Probate and Family Court."],
    traps: [
      "Missing both forms because their addresses end in /download, not .pdf.",
    ],
  },
  "nara-military-records-by-mail": {
    checked: "2026-11-21",
    forms: [
      {
        code: "SF-180",
        file: "https://www.gsa.gov/system/files/2026-07/SF180-26a.pdf",
        linkedFrom:
          "https://www.archives.gov/veterans/military-service-records",
        note:
          "NARA's link redirects to a GSA page, which links the file. Its " +
          "first page is the instruction sheet.",
      },
    ],
    facts: [
      "Completed forms go to the address for the veteran's branch and dates, listed on page 2 of the form, not to the address on the instruction sheet.",
    ],
    traps: [
      "Using a copy on another government's site: a 2010 edition is hosted on a county's .gov site.",
    ],
  },
  "medicare-part-b-enrollment": {
    checked: "2026-11-21",
    forms: [
      {
        code: "CMS-40B",
        edition: "07/2025",
        file: "https://www.cms.gov/medicare/cms-forms/cms-forms/downloads/cms40b-e.pdf",
        linkedFrom:
          "https://www.cms.gov/medicare/cms-forms/cms-forms/cms-forms-items/cms017339",
        note: 'Three pages; prints "CMS-40B (07/2025)" and "Expires: 07/31/2028".',
      },
    ],
    facts: [],
    traps: [
      "Using /files/document/cms-40b-application-enrollment-medicare-part-b-medical-insurance.pdf: " +
        'a CMS page links it, but it is the 06/23 edition and prints "Expires: 04/24".',
    ],
  },
  "va-initial-knee-claim-001": {
    checked: "2026-11-21",
    forms: [
      {
        code: "VA Form 21-526EZ",
        edition: "JAN 2026",
        file: "https://www.vba.va.gov/pubs/forms/VBA-21-526EZ-ARE.pdf",
        linkedFrom: "https://www.va.gov/find-forms/about-form-21-526ez/",
        note:
          "Fifteen pages; the first pages are instructions with nothing to " +
          'fill in. Prints "SUPERSEDES VA FORM 21-526EZ" of the earlier date.',
      },
    ],
    facts: [
      "The claim can be filed online, by mail with this form, or in person at a VA regional office.",
    ],
    traps: [
      "Giving the about-form page as the file: it is a web page.",
      "Using a copy on another government's site, such as a county veterans office.",
    ],
  },
  "ca-workers-comp-back-001": {
    checked: "2026-11-21",
    forms: [
      {
        code: "DWC 1",
        edition: "Rev. 1/1/2016",
        file: "https://www.dir.ca.gov/dwc/DWCForm1.pdf",
        linkedFrom: "https://www.dir.ca.gov/dwc/InjuredWorker.htm",
        note: "One form in English and Spanish; four pages.",
      },
    ],
    facts: [
      "The employee completes the form's employee section.",
      "Once a claim is filed, the employer has to provide medical care.",
    ],
    traps: [
      "Using another language's edition, or a county's own copy of the form.",
    ],
  },
  "uscis-i485-rfe-i864-001": {
    checked: "2026-11-21",
    forms: [
      {
        code: "I-864",
        edition: "08/24/26",
        file: "https://www.uscis.gov/sites/default/files/document/forms/i-864.pdf",
        linkedFrom: "https://www.uscis.gov/i-864",
        note: 'Twelve pages; prints "Expires 10/31/2027".',
      },
    ],
    facts: [
      "Every page has to be from the same edition, with the edition date and page number visible, or USCIS may reject it.",
      "The sponsor's most recent federal tax return goes with it.",
      "Household members whose income is counted each complete an I-864A.",
      "Documents in another language need a certified English translation.",
    ],
    traps: [
      "Giving I-864EZ or I-864A in place of I-864.",
      "Giving I-485 itself: it is already filed; the request is for sponsorship evidence.",
    ],
  },
  "irs-cp90-cdp-001": {
    checked: "2026-11-21",
    forms: [
      {
        code: "Form 12153",
        edition: "Rev. 7-2022",
        file: "https://www.irs.gov/pub/irs-pdf/f12153.pdf",
        linkedFrom:
          "https://www.irs.gov/appeals/collection-due-process-cdp-faqs",
      },
    ],
    facts: ["The hearing has to be requested within 30 days of the notice."],
    traps: ["Giving Form 12153 (sp), the Spanish edition."],
  },
  "ca-dl-renewal": {
    checked: "2026-11-21",
    forms: [
      {
        code: "DL 410 FO",
        edition: "REV. 12/2025",
        file: "https://www.dmv.ca.gov/portal/uploads/2025/12/DL-410-FO-R12-2025-ASB-WWW.pdf",
        linkedFrom:
          "https://www.dmv.ca.gov/portal/driver-licenses-identification-cards/renew-your-driver-license-dl/",
        note:
          "Only for renewing by mail. Its address is dated and moves with " +
          "each revision; the code is printed at the foot of the page.",
      },
    ],
    facts: [
      "A license can be renewed online, by mail or in person.",
      "Online: within 90 days before or 12 months after it expires.",
      "By mail: only if the person can answer no to each eligibility question.",
      "In person: a DL or ID card application, or the renewal notice, and a nonrefundable fee.",
    ],
    traps: [
      "Giving an earlier revision of DL 410 FO from an older dated address.",
    ],
  },
  "irs-address-change": {
    checked: "2026-11-21",
    forms: [
      {
        code: "Form 8822",
        edition: "Rev. February 2021",
        file: "https://www.irs.gov/pub/irs-pdf/f8822.pdf",
        linkedFrom: "https://www.irs.gov/forms-pubs/about-form-8822",
      },
    ],
    facts: [
      "A representative signing for the person attaches a copy of their power of attorney.",
    ],
    traps: ["Giving Form 8822-B: that changes a business address."],
  },
  "dod-discharge-review": {
    checked: "2026-11-21",
    forms: [
      {
        code: "DD 293",
        edition: "02/13/2025",
        file: "https://www.esd.whs.mil/portals/54/documents/dd/forms/dd/dd0293.pdf",
        linkedFrom:
          "https://www.esd.whs.mil/Directives/forms/dd0001_0499/DD293/",
        note:
          "The edition is from the form's page; the file refuses plain " +
          "requests and its print was not read.",
      },
    ],
    facts: [],
    traps: [],
  },
  "pa-replace-license-by-mail": {
    checked: "2026-11-21",
    forms: [
      {
        code: "DL-80",
        edition: "7-25",
        file: "https://www.pa.gov/content/dam/copapwp-pagov/en/penndot/documents/public/dvspubsforms/bdl/bdl-form/dl-80.pdf",
        linkedFrom: "https://www.pa.gov/services/dmv/replace-a-drivers-license",
      },
    ],
    facts: [
      "It can be done online if PennDOT has the person's photo and signature on file.",
      "By mail: the form with a check or money order payable to PennDOT.",
      "If no photo is on file, PennDOT mails a camera card to take to a photo center.",
    ],
    traps: [],
  },
  "wa-replace-lost-title": {
    checked: "2026-11-21",
    forms: [
      {
        code: "TD-420-040",
        edition: "R/3/18",
        file: "https://dol.wa.gov/forms/view/420040",
        linkedFrom:
          "https://dol.wa.gov/vehicles-and-boats/vehicles/vehicle-registration/vehicle-title/replace-lost-title-or-registration",
        note:
          "Affidavit of Loss/Release of Interest; one page. The address " +
          'has no ".pdf" and redirects to the file.',
      },
    ],
    facts: [
      "All registered owners sign in front of a notary, or a vehicle licensing agent.",
      "The form and fee, payable to the Department of Licensing, are mailed or taken to a vehicle licensing office.",
      "Titles are mailed in 6 to 8 weeks; a Quick Title is faster.",
      "If the vehicle is still being paid for, the lienholder has to apply.",
    ],
    traps: ["Missing the file because its address doesn't say pdf."],
  },
  "or-replace-lost-title": {
    checked: "2026-11-21",
    forms: [
      {
        code: "735-515",
        edition: "9-23",
        file: "https://www.oregon.gov/odot/Forms/DMV/515fill.pdf",
        linkedFrom:
          "https://www.oregon.gov/odot/DMV/pages/vehicle/titlereg.aspx",
        note: "Application for Replacement / Duplicate Title; two pages.",
      },
    ],
    facts: ["It is mailed or taken to DMV, 1905 Lana Ave NE, Salem OR 97314."],
    traps: [],
  },
  "ca-court-fee-waiver": {
    checked: "2026-11-21",
    forms: [
      {
        code: "FW-001",
        edition: "Rev. March 1, 2026",
        file: "https://courts.ca.gov/sites/default/files/courts/default/2024-11/fw001.pdf",
        linkedFrom: "https://selfhelp.courts.ca.gov/fee-waiver",
        note: "The folder in its address is older than the edition it holds.",
      },
      {
        code: "FW-003",
        edition: "Rev. September 1, 2019",
        file: "https://courts.ca.gov/sites/default/files/courts/default/2024-11/fw003.pdf",
        linkedFrom: "https://selfhelp.courts.ca.gov/fee-waiver",
        note: "The court's order; the person fills in only its first item.",
      },
    ],
    facts: [
      "Receiving a public benefit such as CalFresh is one basis for a waiver.",
      "What is put on the request is confidential.",
      "A waiver doesn't cover a court reporter's transcript, lawyer fees or fines.",
      "The court may later order fees paid if the person's situation improves.",
    ],
    traps: [
      "Giving FW-001-INFO, the information sheet, as the request.",
      "Giving FW-002: that asks to waive additional fees later.",
    ],
  },
  "san-diego-homeowners-exemption": {
    checked: "2026-11-21",
    forms: [
      {
        code: "BOE-266",
        file: "https://www.sdarcc.gov/content/dam/arcc/assessor/forms/property-tax-exemption-and-exclusion-forms/266HOXCLAIM.pdf",
        linkedFrom:
          "https://www.sdarcc.gov/content/arcc/home/divisions/assessor/property-tax-savings/homeowner-exemption.html",
        note: "The site stalls plain requests; the file's print was not read.",
      },
    ],
    facts: [
      "There is no fee, and it is filed once for as long as the home is the main residence.",
      "February 15 is the deadline for the full exemption; February 16 to December 10 gets 80%.",
      "It can be emailed, mailed to 1600 Pacific Highway, Suite 103, San Diego, CA 92101, or filed in person.",
    ],
    traps: ["Giving the Spanish or the vessels edition, linked beside it."],
  },
  "nyc-parking-ticket-appeal": {
    checked: "2026-11-21",
    forms: [
      {
        code: "PVO-0100",
        edition: "Rev. 02.5.2024",
        file: "https://www.nyc.gov/assets/finance/downloads/pdf/adjudication/pvo-0100.pdf",
        linkedFrom:
          "https://www.nyc.gov/site/finance/vehicles/forms-individual.page",
        note: 'Prints "PVO-0100-online".',
      },
    ],
    facts: [
      "The appeal has to be filed within 30 calendar days of the hearing decision.",
      "It can be decided by mail or argued in person.",
      "A copy of the hearing decision, the summons and all evidence from the hearing go with it.",
    ],
    traps: [],
  },
};
