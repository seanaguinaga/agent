// @vitest-environment node
// The chains measured on 2026-11-21 (see VOUCHING.md): from each country's
// portal to a form, every step a link on the page before. Twelve reached
// their form. Each is walked here as the app would: a step is taken only if
// it may be read, and the form is confirmed only if the page that links it
// and the file are the packet's government's own. A site nothing is kept of
// is judged where a vouched page links it, on its front page as a plain
// request got it on 2026-11-21 (`fixtures/sites`, each cut down to its
// title, footer and links). The decision model is replaced: none is called.
import { readFileSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { internal } from "../../_generated/api";
import type { ActionCtx } from "../../_generated/server";
import { initConvexTest } from "../../setup.test";
import { decide } from "../decisions";
import {
  fakeNetwork,
  restoreNetwork,
  servePage,
  serveStatus,
  type Served,
} from "./network.testkit";
import { confirms, mayRead, parseRegister, sitesAt } from "./sites";

vi.mock("../../modelsForDemo", async () =>
  (await import("../case/cases.testkit")).mockModels(),
);
vi.mock("../decisions", () => ({ decide: vi.fn() }));
afterEach(restoreNetwork);

const usa = "https://www.usa.gov";
const govuk = "https://www.gov.uk";
const canada = "https://www.canada.ca";
const revenue = "https://www.revenue.ie/en";
const servicePublic = "https://www.service-public.gouv.fr";

/** Each chain: the packet's jurisdiction, and its addresses in order. */
const chains: Record<string, [jurisdiction: string, ...chain: string[]]> = {
  "US SSA-561": [
    "us",
    `${usa}/`,
    `${usa}/benefits`,
    `${usa}/what-is-social-security`,
    "https://www.ssa.gov/benefits/disability/",
    "https://www.ssa.gov/forms/",
    "https://www.ssa.gov/forms/ssa-561-u2.pdf",
  ],
  "US IRS 8822": [
    "us",
    `${usa}/`,
    `${usa}/taxes`,
    `${usa}/get-tax-forms`,
    `${usa}/federal-tax-forms`,
    "https://www.irs.gov/forms-instructions",
    "https://www.irs.gov/help/let-us-help-you",
    "https://www.irs.gov/node/19786",
    "https://www.irs.gov/forms-pubs/about-form-8822",
    "https://www.irs.gov/pub/irs-pdf/f8822.pdf",
  ],
  "US USCIS I-130": [
    "us",
    `${usa}/`,
    `${usa}/immigration-and-citizenship`,
    `${usa}/green-card-permanent-resident-immigrant-visa`,
    `${usa}/how-to-get-green-card`,
    `${usa}/adjustment-of-status`,
    "https://www.uscis.gov/green-card/green-card-processes-and-procedures/adjustment-of-status",
    "https://www.uscis.gov/i-130",
    "https://www.uscis.gov/sites/default/files/document/forms/i-130.pdf",
  ],
  "CA DMV REG 343": [
    "us/ca",
    "https://www.ca.gov/",
    "https://www.ca.gov/departments/",
    "https://www.ca.gov/departments/220/",
    "https://www.dmv.ca.gov/portal/vehicle-registration/titles/title-transfers-and-changes/",
    "https://www.dmv.ca.gov/portal/forms/",
    "https://www.dmv.ca.gov/portal/file/application-for-title-or-registration-reg-343-pdf/",
  ],
  "UK HMRC SA100": [
    "gb",
    `${govuk}/`,
    `${govuk}/self-assessment-tax-returns`,
    `${govuk}/self-assessment-tax-returns/sending-return`,
    `${govuk}/government/publications/self-assessment-tax-return-sa100`,
    "https://assets.publishing.service.gov.uk/media/69c14d07cfa346b9d4704a8d/SA100-2026.pdf",
  ],
  "UK DVLA V62": [
    "gb",
    `${govuk}/`,
    `${govuk}/browse/driving`,
    `${govuk}/browse/driving/number-plate`,
    `${govuk}/vehicle-log-book`,
    `${govuk}/vehicle-log-book/if-you-cannot-apply-online`,
    `${govuk}/government/publications/application-for-a-vehicle-registration-certificate`,
    "https://assets.publishing.service.gov.uk/media/691afc5a0dcbf6343e9a2883/v62-application-for-a-registration-certificate.pdf",
  ],
  "Canada CRA T1-ADJ": [
    "ca",
    `${canada}/en.html`,
    `${canada}/en/services/taxes.html`,
    `${canada}/content/canadasite/en/revenue-agency/services/forms-publications.html`,
    `${canada}/en/revenue-agency/services/forms-publications/forms.html`,
    `${canada}/en/revenue-agency/services/forms-publications/forms/t1-adj.html`,
    `${canada}/content/dam/cra-arc/formspubs/pbg/t1-adj/t1-adj-23e.pdf`,
  ],
  "Canada IRCC IMM 5257": [
    "ca",
    `${canada}/en.html`,
    `${canada}/en/services/immigration-citizenship.html`,
    `${canada}/content/canadasite/en/immigration-refugees-citizenship/services/application.html`,
    `${canada}/en/immigration-refugees-citizenship/services/application/application-forms-guides.html`,
    `${canada}/en/immigration-refugees-citizenship/services/application/application-forms-guides/imm5257.html`,
    `${canada}/content/dam/ircc/documents/pdf/english/kits/forms/imm5257/01-11-2026/imm5257e.pdf`,
  ],
  "Ireland Revenue Form 12": [
    "ie",
    "https://www.gov.ie/en/",
    "https://www.gov.ie/en/departments/",
    "https://www.gov.ie/en/office-of-the-revenue-commissioners/",
    `${revenue}/home.aspx`,
    `${revenue}/jobs-and-pensions/index.aspx`,
    `${revenue}/jobs-and-pensions/end-of-year-process/index.aspx`,
    `${revenue}/jobs-and-pensions/end-of-year-process/paye-income-tax-return.aspx`,
    `${revenue}/self-assessment-and-self-employment/documents/form-12s.pdf`,
  ],
  "NZ IRD IR3": [
    "nz",
    "https://www.govt.nz/",
    "https://www.govt.nz/browse/work-and-tax/",
    "https://www.govt.nz/browse/work-and-tax/tax-and-acc-levies/end-of-year-income-tax-assessments/",
    "https://www.ird.govt.nz/income-tax/income-tax-for-individuals/what-happens-at-the-end-of-the-tax-year/individual-income-tax-return---ir3/complete-my-individual-income-tax-return---ir3",
    "https://www.ird.govt.nz/-/media/project/ir/home/documents/forms-and-guides/ir1---ir99/ir3/ir3-2026.pdf",
  ],
  // Its form is a page: the link to a blank PDF answers 404.
  "France cerfa 13750": [
    "fr",
    `${servicePublic}/`,
    `${servicePublic}/particuliers/vosdroits/N19812`,
    `${servicePublic}/particuliers/vosdroits/N367`,
    `${servicePublic}/particuliers/vosdroits/R13567`,
    `${servicePublic}/simulateur/calcul/13750`,
  ],
  "India Passport Seva": [
    "in",
    "https://www.india.gov.in/",
    "https://www.india.gov.in/category/citizenship-visa-passports",
    "https://www.passportindia.gov.in/psp/Apply",
    "https://www.passportindia.gov.in/AppOnlineProject/pdf/AnnexureH.pdf",
  ],
};

const register = [
  "Domain name,Domain type,Organization name,Suborganization name,City,State",
  "usa.gov,Federal - Executive,General Services Administration,,Washington,DC",
  "ssa.gov,Federal - Executive,Social Security Administration,,Baltimore,MD",
  "irs.gov,Federal - Executive,Department of the Treasury,IRS,Washington,DC",
  "uscis.gov,Federal - Executive,Department of Homeland Security,USCIS,,DC",
  "ca.gov,State or territory,State of California,,Rancho Cordova,CA",
  "alamedacountyca.gov,County,Alameda County,,Oakland,CA",
  "oregon.gov,State or territory,State of Oregon,,Salem,OR",
].join("\n");

/**
 * Whose the decision model says each site is: on a shared suffix, which
 * government's; linked, the linking government's `own` or not. It would
 * call the last three a government's own: nothing supports them, so it is
 * never asked.
 */
const owners: Record<string, string> = {
  "www.gov.uk": "national",
  "service.gov.uk": "national",
  "ird.govt.nz": "national",
  "passportindia.gov.in": "national",
  "ato.gov.au": "national",
  "revenue.ie": "own",
  "acgov.org": "own",
  "formulare-bfinv.de": "own",
  "iorder.com.au": "contractor",
  "taxadmin.org": "own",
  "careeronestop.org": "own",
  "auspost.com.au": "own",
};

const saved = (name: string) =>
  servePage(
    readFileSync(new URL(`./fixtures/sites/${name}.html`, import.meta.url), {
      encoding: "utf8",
    }),
  );
const to = (location: string) => () =>
  new Response(null, { status: 302, headers: { location } });

const ato =
  "https://www.ato.gov.au/individuals-and-families/tax-file-number/apply-for-a-tfn/australian-residents-tfn-application";
const iorder =
  "https://iorder.com.au/publication/searchpublications.aspx?txt=1432";
const bmf =
  "https://www.bundesfinanzministerium.de/Web/DE/Themen/Steuern/Formulare/formulare.html";

/** The pages as they answered a plain request, redirects and refusals too. */
const pages: Record<string, Served> = {
  "https://www.alamedacountyca.gov/": saved("alamedacountyca.gov"),
  "https://acgov.org/": saved("acgov.org"),
  [bmf]: saved("bundesfinanzministerium.de-formulare"),
  "https://www.formulare-bfinv.de/": saved("formulare-bfinv.de"),
  [`${usa}/state-taxes`]: saved("usa.gov-state-taxes"),
  [`${usa}/job-help`]: saved("usa.gov-job-help"),
  "https://taxadmin.org/": saved("taxadmin.org"),
  "https://www.careeronestop.org/": serveStatus(403),
  "https://iorder.com.au/": to("/publication/main.aspx"),
  "https://iorder.com.au/publication/main.aspx": saved("iorder.com.au"),
  "https://auspost.com.au/": saved("auspost.com.au"),
  "https://www.revenue.ie/": to("https://www.revenue.ie:443/en/home.aspx"),
  [`${revenue}/home.aspx`]: saved("revenue.ie"),
  // The ATO and gov.ie refuse a plain request: these two stand in for the
  // pages the measurement's browser read, with the links it found on them.
  [ato]: servePage(
    `<a href="${iorder}">Order NAT 1432</a><a href="https://auspost.com.au/">Australia Post</a>`,
  ),
  "https://www.gov.ie/en/office-of-the-revenue-commissioners/": servePage(
    `<a href="${revenue}/home.aspx">revenue.ie</a>`,
  ),
};

async function measured() {
  const t = initConvexTest();
  fakeNetwork(pages);
  vi.mocked(decide).mockReset();
  vi.mocked(decide).mockImplementation((async (
    _ctx: ActionCtx,
    question: { state: { site: string } },
  ) => ({ choice: owners[question.state.site], confidence: 0.9 })) as never);
  await t.mutation(internal.easygov.forms.sites.putSites, {
    sites: parseRegister(register),
    at: 1,
  });
  const ctx = { runQuery: t.query } as unknown as ActionCtx;
  const { judgeSite, readLinks } = internal.easygov.forms.actions;
  /** Judges the site `url` is on, as the page `from` links it. */
  const linked = async (url: string, from: string) => {
    await t.action(readLinks, { url: from, way: "request", spend: true });
    return await t.action(judgeSite, { url, from });
  };
  /** How far a chain is read, and whether its form is then confirmed. */
  const walk = async (jurisdiction: string, chain: string[]) => {
    const [page, file] = chain.slice(-2);
    // As finding a form does: the two ends of the link are judged first,
    // and a site nothing is kept of where a vouched page links it.
    for (const url of [page, file]) await t.action(judgeSite, { url });
    for (const [i, url] of chain.entries()) {
      const sites = await sitesAt(ctx, chain);
      if (i && !sites(url) && sites(chain[i - 1])?.state === "vouched") {
        await linked(url, chain[i - 1]);
      }
    }
    const on = await sitesAt(ctx, chain);
    const stopped = chain.findIndex(
      (url, i) => !mayRead(url, on(url), i ? on(chain[i - 1]) : undefined),
    );
    return {
      read: stopped < 0 ? chain.length : stopped,
      confirmed: confirms(jurisdiction, on(page), on(file)),
    };
  };
  return { t, walk, linked, on: (urls: string[]) => sitesAt(ctx, urls) };
}

test("the 12 measured chains are read to the end and confirmed, one by a link vouch", async () => {
  const { walk, on } = await measured();
  const results: Record<string, { read: string; confirmed: boolean }> = {};
  for (const [target, [jurisdiction, ...chain]] of Object.entries(chains)) {
    const { read, confirmed } = await walk(jurisdiction, chain);
    results[target] = { read: `${read}/${chain.length}`, confirmed };
  }
  for (const [target, { read, confirmed }] of Object.entries(results)) {
    const [steps, of] = read.split("/");
    expect([target, steps, confirmed]).toEqual([target, of, true]);
  }
  expect(Object.keys(results)).toHaveLength(12);
  // gov.ie links revenue.ie, on an open name: it links gov.ie back, and is
  // vouched as the Irish government's, one link from a hand line.
  expect((await on([`${revenue}/`]))(`${revenue}/`)).toEqual({
    state: "vouched",
    domain: "revenue.ie",
    name: "Welcome to revenue.ie",
    owner: { level: "national", country: "ie" },
    via: {
      kind: "link",
      from: "https://www.gov.ie/en/office-of-the-revenue-commissioners/",
      support: "back",
      steps: 1,
    },
  });
  // Five sites were judged, once each: the two .gov.uk sites, ird.govt.nz,
  // passportindia.gov.in and revenue.ie.
  expect(decide).toHaveBeenCalledTimes(5);
});

test("a linked site is vouched only where the model and something structural both say it is the government's", async () => {
  const { t, linked } = await measured();
  const via = (from: string) => ({
    kind: "link",
    from,
    support: "back",
    steps: 1,
  });
  // The county's registered site and acgov.org link each other.
  const county = "https://www.alamedacountyca.gov/";
  expect(await linked("https://acgov.org/government/", county)).toEqual({
    state: "vouched",
    domain: "acgov.org",
    name: "Home | Alameda County Government",
    owner: {
      level: "local",
      country: "us",
      region: "us-ca",
      body: "Alameda County",
    },
    via: via(county),
  });
  // The finance ministry's forms page links its form server, which links
  // the ministry back.
  const forms = "https://www.formulare-bfinv.de/ffw/content.do";
  expect(await linked(forms, bmf)).toEqual({
    state: "vouched",
    domain: "formulare-bfinv.de",
    name: "Formular-Management-System",
    owner: { level: "national", country: "de" },
    via: via(bmf),
  });
  expect(decide).toHaveBeenCalledTimes(2);

  // The ATO's order form links the ATO back, and is a vendor's: the model
  // says so. A contractor is never vouched.
  await t.action(internal.easygov.forms.actions.judgeSite, { url: ato });
  const declined = (domain: string, why: string) => ({
    state: "declined",
    domain,
    why,
  });
  expect(await linked(iorder, ato)).toEqual(
    declined("iorder.com.au", "contractor"),
  );
  expect(decide).toHaveBeenCalledTimes(4);
  // The rest have nothing but the link, so the model isn't asked. An
  // association of state tax offices links the states, not the nation whose
  // page links it; a job site refuses the request; the post office links no
  // government at all.
  for (const [url, from, domain] of [
    [
      "https://taxadmin.org/state-tax-forms/",
      `${usa}/state-taxes`,
      "taxadmin.org",
    ],
    [
      "https://www.careeronestop.org/JobSearch/FindJobs/find-jobs.aspx",
      `${usa}/job-help`,
      "careeronestop.org",
    ],
    ["https://auspost.com.au/", ato, "auspost.com.au"],
  ]) {
    expect(await linked(url, from)).toEqual(declined(domain, "unsupported"));
  }
  expect(decide).toHaveBeenCalledTimes(4);
  // Each is listed for a person to review, latest first.
  const review = await t.query(internal.easygov.forms.sites.toReview, {});
  expect(review.map(({ domain, why }) => [domain, why])).toEqual([
    ["auspost.com.au", "unsupported"],
    ["careeronestop.org", "unsupported"],
    ["taxadmin.org", "unsupported"],
    ["iorder.com.au", "contractor"],
  ]);
});

test("a copy, a vendor and a search-only address are read only as a government's page links them, and never confirm", async () => {
  const { walk, on } = await measured();
  const dmv = "https://www.dmv.ca.gov/portal/forms/";
  const others = [
    // The ATO's order form for NAT 1432: a vendor's site.
    iorder,
    // A copy site that looks official.
    "https://www.dmv.org/ca-california/forms/reg-343.pdf",
    // usa.gov links it, and a search cites it.
    "https://www.taxadmin.org/state-tax-forms",
    // The old host of France's forms, which service-public.gouv.fr links.
    "https://www.formulaires.service-public.fr/gf/cerfa_13750.do",
  ];
  const sites = await on([ato, dmv, ...others]);
  for (const url of others) {
    expect(sites(url)).toBeUndefined();
    // Cited by a search alone, or linked from another such site: not read.
    expect(mayRead(url, sites(url))).toBe(false);
    expect(mayRead(url, sites(url), sites(others[0]))).toBe(false);
    // Linked from a government's page: read, and never confirmed.
    expect(mayRead(url, sites(url), sites(ato))).toBe(true);
    expect(mayRead(url, sites(url), sites(dmv))).toBe(true);
  }
  expect(await walk("au", [ato, others[0]])).toEqual({
    read: 2,
    confirmed: false,
  });
  expect(await walk("us/ca", [dmv, others[1]])).toEqual({
    read: 2,
    confirmed: false,
  });
  expect(await walk("us", [`${usa}/federal-tax-forms`, others[2]])).toEqual({
    read: 2,
    confirmed: false,
  });
});
