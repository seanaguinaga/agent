// Whose a government's site is, and which pages and files confirm a form.
import { describe, expect, test } from "vitest";
import { internal } from "../../_generated/api";
import { initConvexTest } from "../../setup.test";
import { confirms, parseRegister, type Owner, type Site } from "./sites";
import { handFor } from "./sources";

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
      domain: "ssa.gov",
      name: "Social Security Administration",
      owner: national,
      via,
    },
    {
      domain: "va.gov",
      name: "Office of IT, Operations",
      owner: national,
      via,
    },
    {
      domain: "ca.gov",
      name: "State of California",
      owner: { level: "region", country: "us", region: "us-ca" },
      via,
    },
    {
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
  expect(
    parseRegister(`${header}\nx.gov,Regional,Some Body,,,CA,`),
  ).toEqual([]);
});

describe("confirms", () => {
  const site = (domain: string, owner: Owner): Site => ({
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
  });
});

test("a host is looked up by its registrable domain, or its hand-kept line", async () => {
  const t = initConvexTest();
  const sites = parseRegister(csv);
  await t.mutation(internal.easygov.forms.sites.putSites, { sites, at: 1 });
  const sitesOf = (hosts: string[]) =>
    t.query(internal.easygov.forms.sites.sitesOf, { hosts });
  expect(
    await sitesOf([
      "www.dmv.ca.gov",
      "www.ssa.gov",
      "forms.example.gov",
      "www.acgov.org",
      "www.esd.whs.mil",
      "www.dmv.org",
    ]),
  ).toEqual([
    { host: "www.dmv.ca.gov", site: sites[2] },
    { host: "www.ssa.gov", site: sites[0] },
    { host: "www.acgov.org", site: handFor("acgov.org") },
    { host: "www.esd.whs.mil", site: handFor("army.mil") },
  ]);
  // The county's hand-kept site and its registered one are one body's.
  const [{ site: registered }] = await sitesOf(["www.alamedacountyca.gov"]);
  expect(confirms("us/ca/alameda", handFor("www.acgov.org"), registered)).toBe(
    true,
  );
  // The military's sites are the nation's.
  expect(confirms("us", handFor("www.army.mil"), handFor("www.navy.mil"))).toBe(
    true,
  );
  expect(confirms("us/va", handFor("army.mil"), handFor("army.mil"))).toBe(
    true,
  );
  // A domain the register stops listing is forgotten.
  await t.mutation(internal.easygov.forms.sites.putSites, {
    sites: sites.slice(0, 1),
    at: 2,
  });
  expect(
    await t.mutation(internal.easygov.forms.sites.dropSites, { before: 2 }),
  ).toBe(false);
  expect(await sitesOf(["va.gov", "www.ssa.gov"])).toEqual([
    { host: "www.ssa.gov", site: sites[0] },
  ]);
});
