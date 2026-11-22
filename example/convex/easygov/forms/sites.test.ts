// @vitest-environment node
// Whose a government's site is, which addresses may be read, and which
// pages and files confirm a form. The decision model is replaced at its
// module, and the network by a stand-in: no model is called.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "../../_generated/api";
import type { ActionCtx } from "../../_generated/server";
import { initConvexTest } from "../../setup.test";
import { decide } from "../decisions";
import { governed, GOVERNMENTS } from "./governments";
import { fakeNetwork, restoreNetwork, servePage } from "./network.testkit";
import {
  confirms,
  judged,
  mayRead,
  ownerQuestion,
  parseRegister,
  sitesAt,
  type Owner,
  type Site,
} from "./sites";

vi.mock("../../modelsForDemo", async () =>
  (await import("../case/cases.testkit")).mockModels(),
);
vi.mock("../decisions", () => ({ decide: vi.fn() }));
const decideMock = vi.mocked(decide);
beforeEach(() => void decideMock.mockReset());
afterEach(restoreNetwork);

const header =
  "Domain name,Domain type,Organization name,Suborganization name,City,State,Security contact email";
const csv = [
  header,
  "ssa.gov,Federal - Executive,Social Security Administration,,Baltimore,MD,soc@ssa.gov",
  'va.gov,Federal - Executive,Department of Veterans Affairs,"Office of IT, Operations",Washington,DC,x@va.gov',
  "ca.gov,State or territory,State of California,,Rancho Cordova,CA,(blank)",
  "alamedacountyca.gov,County,Alameda County,,Oakland,CA,(blank)",
  "navajo-nsn.gov,Tribal,Navajo Nation,,Window Rock,AZ,(blank)",
  "nowhere.gov,State or territory,A State,,,,(blank)",
].join("\n");

const via = { kind: "register", register: "cisa" } as const;
const national: Owner = { level: "national", country: "us" };

test("the register is read for whose each domain is, and never its contacts", () => {
  const sites = parseRegister(csv);
  expect(sites).toEqual([
    {
      state: "vouched",
      domain: "ssa.gov",
      name: "Social Security Administration",
      owner: national,
      via,
    },
    {
      state: "vouched",
      domain: "va.gov",
      name: "Office of IT, Operations",
      owner: national,
      via,
    },
    {
      state: "vouched",
      domain: "ca.gov",
      name: "State of California",
      owner: { level: "region", country: "us", region: "us-ca" },
      via,
    },
    {
      state: "vouched",
      domain: "alamedacountyca.gov",
      name: "Alameda County",
      owner: {
        level: "local",
        country: "us",
        region: "us-ca",
        body: "Alameda County",
      },
      via,
    },
    {
      state: "vouched",
      domain: "navajo-nsn.gov",
      name: "Navajo Nation",
      owner: {
        level: "local",
        country: "us",
        region: "us-az",
        body: "Navajo Nation",
      },
      via,
    },
    // A state's domain in no state is nobody's: it is left out.
  ]);
  expect(JSON.stringify(sites)).not.toContain("@");
  // A kind of domain the register didn't have isn't guessed at: that domain
  // is left out, and the rest is kept.
  expect(parseRegister(`${header}\nx.gov,Regional,Some Body,,,CA,`)).toEqual(
    [],
  );
});

describe("confirms", () => {
  const site = (domain: string, owner: Owner): Site => ({
    state: "vouched",
    domain,
    name: domain,
    owner,
    via,
  });
  const region = (code: string) =>
    site(`${code}.gov`, { level: "region", country: "us", region: code });
  const local = (body: string, code = "us-ca", domain = `${body}.gov`) =>
    site(domain, { level: "local", country: "us", region: code, body });
  const ssa = site("ssa.gov", national);
  const irs = site("irs.gov", national);
  const [ca, nv] = [region("us-ca"), region("us-nv")];
  const alameda = local("alameda");

  test("a page and a file of the packet's government, on one site or two", () => {
    expect(confirms("us", ssa, ssa)).toBe(true);
    expect(confirms("us/ca", ca, ca)).toBe(true);
    expect(confirms("us/ca/alameda", alameda, alameda)).toBe(true);
    // A national government is one owner: an agency's page, another's file.
    expect(confirms("us", irs, ssa)).toBe(true);
    // One body's two sites.
    expect(
      confirms("us/ca/alameda", alameda, local("alameda", "us-ca", "ac.org")),
    ).toBe(true);
  });

  test("a government above the packet's is accepted, never one below or beside", () => {
    // A county's page linking the state's file, and a state's the nation's.
    expect(confirms("us/ca/alameda", alameda, ca)).toBe(true);
    expect(confirms("us/ca/alameda", ca, ssa)).toBe(true);
    expect(confirms("us/ca", ca, ssa)).toBe(true);
    // A state's copy of a federal form, and a county's of a state one.
    expect(confirms("us", ssa, ca)).toBe(false);
    expect(confirms("us", ca, ca)).toBe(false);
    expect(confirms("us/ca", ca, alameda)).toBe(false);
    expect(confirms("us/ca", alameda, alameda)).toBe(false);
    // Another state's site, another state's county, another country's.
    expect(confirms("us/ca", nv, nv)).toBe(false);
    expect(confirms("us/ca", ca, nv)).toBe(false);
    expect(confirms("us/tx/travis", alameda, alameda)).toBe(false);
    expect(confirms("ca", ssa, ssa)).toBe(false);
  });

  test("two local bodies are never one another's", () => {
    expect(confirms("us/ca/alameda", alameda, local("oakland"))).toBe(false);
    // A local body the register puts in no state is in no packet's.
    const lost = site("lost.gov", { level: "local", country: "us", body: "x" });
    expect(confirms("us/ca/alameda", lost, lost)).toBe(false);
  });

  test("both have to be on vouched sites", () => {
    expect(confirms("us", ssa, undefined)).toBe(false);
    expect(confirms("us", undefined, ssa)).toBe(false);
    // A site nobody has judged, or one declined, is nobody's yet.
    expect(confirms("us", ssa, governed("new.gov"))).toBe(false);
    expect(
      confirms("us", ssa, {
        state: "declined",
        domain: "x.gov",
        why: "unsure",
      }),
    ).toBe(false);
  });
});

const DAY = 24 * 60 * 60 * 1000;

/** A test deployment, the sites its addresses are on, and its judge. */
function deployment() {
  const t = initConvexTest();
  const ctx = { runQuery: t.query } as unknown as ActionCtx;
  return {
    t,
    put: (sites: Site[], at: number) =>
      t.mutation(internal.easygov.forms.sites.putSites, {
        sites: sites as never,
        at,
      }),
    siteOf: async (url: string) => (await sitesAt(ctx, [url]))(url),
    sitesAt: (urls: string[]) => sitesAt(ctx, urls),
    judge: (url: string, link: { label?: string; under?: string } = {}) =>
      t.action(internal.easygov.forms.actions.judgeSite, { url, ...link }),
  };
}

/** Has the decision model say whose each site is, by its domain. */
function judging(owners: Record<string, string>, confidence = 0.9) {
  decideMock.mockImplementation((async (
    _ctx: ActionCtx,
    question: { state: { site: string } },
  ) => ({
    choice: owners[question.state.site] ?? "unsure",
    confidence,
  })) as never);
}

describe("governments.ts", () => {
  const suffixes = GOVERNMENTS.flatMap(({ suffixes }) => suffixes);

  test("every suffix cites its registry's policy, and every hand line its evidence", () => {
    for (const { policy } of suffixes) expect(policy).toMatch(/^https:\/\//);
    for (const { hand } of GOVERNMENTS) {
      for (const { note } of hand) expect(note.length).toBeGreaterThan(20);
    }
    // No citation, no suffix: .gouv.sn stays out.
    expect(suffixes.map(({ suffix }) => suffix)).not.toContain("gouv.sn");
    expect(governed("www.finances.gouv.sn")).toBeUndefined();
  });

  test("a country on an open name starts from a root that is its national government's", () => {
    const roots = GOVERNMENTS.flatMap(({ root }) => root ?? []);
    expect(roots).toEqual(["canada.ca", "gov.ie", "bund.de", "primature.sn"]);
    for (const root of roots) {
      expect(governed(`www.${root}`)).toMatchObject({
        state: "vouched",
        owner: { level: "national" },
        via: { kind: "hand" },
      });
    }
  });

  test("a name says whose a site is only by a hand line, or a suffix with one owner", () => {
    expect(governed("www.acgov.org")).toMatchObject({
      state: "vouched",
      owner: { level: "local", region: "us-ca", body: "Alameda County" },
    });
    expect(governed("www.dgid.sn")).toMatchObject({
      owner: { level: "national", country: "sn" },
    });
    // The military's sites are the nation's, and so are France's .gouv.fr.
    const [army, navy] = [governed("www.army.mil"), governed("www.navy.mil")];
    expect(army).toMatchObject({ domain: "army.mil", via: { kind: "suffix" } });
    expect(confirms("us", army, navy)).toBe(true);
    expect(confirms("us/va", army, army)).toBe(true);
    expect(governed("www.impots.gouv.fr")).toMatchObject({
      domain: "impots.gouv.fr",
      owner: { level: "national", country: "fr" },
    });
    // A suffix several governments share proves a government's, not whose:
    // the site is the registrable domain, as the Public Suffix List tells it.
    expect(governed("assets.publishing.service.gov.uk")).toEqual({
      state: "unjudged",
      domain: "service.gov.uk",
      country: "gb",
      suffix: "gov.uk",
    });
    expect(governed("www.ato.gov.au")).toMatchObject({ domain: "ato.gov.au" });
    // A name that only looks official is nobody's.
    for (const host of ["www.dmv.org", "notacgov.org", "acgov.org.example.com"])
      expect(governed(host)).toBeUndefined();
    expect(governed("ssa.gov.example.com")).toBeUndefined();
    expect(governed("gov.uk.example.com")).toBeUndefined();
  });
});

describe("mayRead", () => {
  const ssa = governed("www.ssa.gov");
  const file = "https://www.ssa.gov/forms/ssa-561.pdf";

  test("an address on a government's own site, by https and nothing odd", () => {
    expect(mayRead(file, ssa)).toBe(true);
    expect(mayRead("https://www.acgov.org/a.pdf", governed("acgov.org"))).toBe(
      true,
    );
    for (const odd of [
      "http://www.ssa.gov/forms",
      "https://user:secret@www.ssa.gov/forms",
      "https://www.ssa.gov:8443/forms",
      "https://10.0.0.1/forms",
      "https://[::1]/forms",
      "https://localhost/forms",
      "https://printer.local/forms",
      "https://intranet/forms",
      "not an address",
    ]) {
      expect(mayRead(odd, ssa, ssa)).toBe(false);
    }
  });

  test("an address on nobody's site, only where a government's page links or redirects to it", () => {
    const copy = "https://www.dmv.org/forms/reg-343.pdf";
    const vendor = "https://iorder.com.au/publication/searchpublications.aspx";
    const cited = "https://www.taxadmin.org/state-tax-forms";
    for (const url of [copy, vendor, cited, "https://forms-irs.us/f8822.pdf"]) {
      // A search citing it is no reason to read it.
      expect(mayRead(url, governed(new URL(url).hostname))).toBe(false);
      expect(mayRead(url, undefined, ssa)).toBe(true);
      // Nor is a page that is itself on nobody's site: one link, no further.
      expect(mayRead(url, undefined, undefined)).toBe(false);
    }
    // A site judged a contractor's is nobody's, wherever its name is.
    const declined: Site = {
      state: "declined",
      domain: "vendor.gov.au",
      why: "contractor",
    };
    expect(mayRead("https://vendor.gov.au/", declined)).toBe(false);
    expect(mayRead(copy, undefined, declined)).toBe(false);
    // And none of them ever confirms a form, whatever links it.
    const ato = judged(governed("www.ato.gov.au") as never, "ATO", {
      choice: "national",
      confidence: 0.9,
    });
    for (const url of [copy, vendor, cited]) {
      expect(confirms("au", ato, governed(new URL(url).hostname))).toBe(false);
    }
  });
});

describe("whose a site on a shared suffix is", () => {
  const ato = governed("www.ato.gov.au") as Extract<
    Site,
    { state: "unjudged" }
  >;
  const says = (choice: string, confidence = 0.9) =>
    judged(ato, "Australian Taxation Office", {
      choice: choice as never,
      confidence,
    });

  test("the question offers the nation, each of its regions, a local body, a contractor, or unsure", () => {
    const question = ownerQuestion(ato, {
      label: "Apply for a TFN",
      title: "Australian Taxation Office",
    });
    expect(Object.keys(question.criteria)).toEqual([
      "national",
      ...["act", "nsw", "nt", "qld", "sa", "tas", "vic", "wa"].map(
        (code) => `region:${code}`,
      ),
      "local",
      "contractor",
      "unsure",
    ]);
    expect(question.state).toEqual({
      site: "ato.gov.au",
      label: "Apply for a TFN",
      title: "Australian Taxation Office",
    });
  });

  test("a sure answer vouches the site as that government's", () => {
    const via = { kind: "suffix", suffix: "gov.au" };
    expect(says("national")).toEqual({
      state: "vouched",
      domain: "ato.gov.au",
      name: "Australian Taxation Office",
      owner: { level: "national", country: "au" },
      via,
    });
    expect(says("region:nsw")).toMatchObject({
      owner: { level: "region", country: "au", region: "au-nsw" },
    });
    expect(says("local")).toMatchObject({
      owner: { level: "local", country: "au", body: "ato.gov.au" },
    });
  });

  test("a contractor, a guess, or no certainty declines it; no answer keeps nothing", () => {
    const declined = { state: "declined", domain: "ato.gov.au" };
    expect(says("contractor")).toEqual({ ...declined, why: "contractor" });
    expect(says("unsure")).toEqual({ ...declined, why: "unsure" });
    expect(says("national", 0.7)).toEqual({ ...declined, why: "unsure" });
    expect(judged(ato, "ATO", { choice: "national" })).toEqual({
      ...declined,
      why: "unsure",
    });
    expect(judged(ato, "ATO", undefined)).toBeUndefined();
  });

  test("it is asked once, with what the site and the linking page say, and kept", async () => {
    const { judge, siteOf } = deployment();
    const network = fakeNetwork({
      "https://www.ato.gov.au/": servePage(
        "<title>Australian Taxation Office</title><footer>© Commonwealth of Australia</footer>",
      ),
    });
    judging({ "ato.gov.au": "national" });
    const page = "https://www.ato.gov.au/forms/tfn";
    const vouched = {
      state: "vouched",
      domain: "ato.gov.au",
      name: "Australian Taxation Office",
      owner: { level: "national", country: "au" },
      via: { kind: "suffix", suffix: "gov.au" },
    };
    expect(await judge(page, { label: "Apply for a TFN" })).toEqual(vouched);
    expect(decideMock.mock.calls[0][1].state).toEqual({
      site: "ato.gov.au",
      label: "Apply for a TFN",
      title: "Australian Taxation Office",
      footer: "© Commonwealth of Australia",
    });
    // Kept: the next ask, and every lookup, has it with no call.
    expect(await judge(page)).toEqual(vouched);
    expect(await siteOf("https://www.ato.gov.au/other")).toEqual(vouched);
    expect(decideMock).toHaveBeenCalledTimes(1);
    expect(network.asked("https://www.ato.gov.au/")).toBe(1);
  });

  test("a suffix with one owner, a hand line and a registered domain are never asked", async () => {
    const { judge, put } = deployment();
    fakeNetwork({});
    await put(parseRegister(csv), 1);
    for (const url of [
      "https://www.impots.gouv.fr/",
      "https://www.army.mil/",
      "https://www.canada.ca/",
      "https://www.ssa.gov/",
    ]) {
      expect(await judge(url)).toMatchObject({ state: "vouched" });
    }
    expect(await judge("https://www.dmv.org/")).toBeNull();
    expect(decideMock).not.toHaveBeenCalled();
  });

  test("a declined site stays declined for 30 days, then is judged again", async () => {
    const { judge, put, siteOf } = deployment();
    fakeNetwork({});
    const home = "https://portal.gov.au/";
    judging({ "portal.gov.au": "contractor" });
    const declined = { state: "declined", domain: "portal.gov.au" };
    expect(await judge(home)).toEqual({ ...declined, why: "contractor" });
    expect(await judge(home)).toEqual({ ...declined, why: "contractor" });
    expect(decideMock).toHaveBeenCalledTimes(1);
    expect(mayRead(home, await siteOf(home))).toBe(false);
    // The same row, 31 days old: as if never judged.
    await put(
      [{ state: "declined", domain: "portal.gov.au", why: "contractor" }],
      Date.now() - 31 * DAY,
    );
    expect(await siteOf(home)).toMatchObject({ state: "unjudged" });
    judging({ "portal.gov.au": "national" }, 0.5);
    expect(await judge(home)).toEqual({ ...declined, why: "unsure" });
    // A model that can't be reached keeps nothing: the site is still unjudged.
    await put([{ ...declined, why: "unsure" } as Site], Date.now() - 31 * DAY);
    decideMock.mockResolvedValue(undefined);
    expect(await judge(home)).toMatchObject({ state: "unjudged" });
  });
});

test("a host is looked up by its registrable domain, and the register's word stands", async () => {
  const { t, put, sitesAt } = deployment();
  const sites = parseRegister(csv);
  await put(sites, 1);
  const urls = [
    "https://www.dmv.ca.gov/portal/",
    "https://www.ssa.gov/forms/",
    "https://forms.example.gov/",
    "https://www.acgov.org/",
    "https://www.dmv.org/",
    "http://www.ssa.gov/forms/",
  ];
  const on = await sitesAt(urls);
  expect(urls.map(on)).toEqual([
    sites[2],
    sites[0],
    // On .gov, and not in the register: a government's, nobody knows whose.
    { state: "unjudged", domain: "example.gov", country: "us", suffix: "gov" },
    governed("acgov.org"),
    undefined,
    // An address that couldn't be read is on no site.
    undefined,
  ]);
  // The county's hand-kept site and its registered one are one body's.
  const county = "https://www.alamedacountyca.gov/";
  expect(
    confirms(
      "us/ca/alameda",
      governed("www.acgov.org"),
      (await sitesAt([county]))(county),
    ),
  ).toBe(true);
  // A judgment never replaces the register's word, and outlives its imports.
  const guess: Site = {
    state: "declined",
    domain: "ssa.gov",
    why: "unsure",
  };
  const judgedSite = judged(governed("x.gov.au") as never, "X", {
    choice: "national",
    confidence: 1,
  })!;
  await put([guess, judgedSite], 1);
  // A domain the register stops listing is forgotten.
  await put(sites.slice(0, 1), 2);
  expect(
    await t.mutation(internal.easygov.forms.sites.dropSites, { before: 2 }),
  ).toBe(false);
  const after = await sitesAt([
    "https://va.gov/",
    "https://www.ssa.gov/",
    "https://x.gov.au/",
  ]);
  expect(after("https://va.gov/")).toMatchObject({ state: "unjudged" });
  expect(after("https://www.ssa.gov/")).toEqual(sites[0]);
  expect(after("https://x.gov.au/")).toEqual(judgedSite);
});
