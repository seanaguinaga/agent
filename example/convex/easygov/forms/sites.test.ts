// Who an official site belongs to, from CISA's register.
import { describe, expect, test } from "vitest";
import { internal } from "../../_generated/api";
import { initConvexTest } from "../../setup.test";
import { domainOf, ownSite, parseRegister, type Domain } from "./sites";

const csv = [
  "Domain name,Domain type,Organization name,Suborganization name,City,State,Security contact email",
  "ssa.gov,Federal - Executive,Social Security Administration,,Baltimore,MD,soc@ssa.gov",
  'va.gov,Federal - Executive,Department of Veterans Affairs,"Office of IT, Operations",Washington,DC,x@va.gov',
  "ca.gov,State or territory,State of California,,Rancho Cordova,CA,(blank)",
].join("\n");

test("the register is read for who owns each domain, and never its contacts", () => {
  const sites = parseRegister(csv);
  expect(sites).toEqual([
    {
      domain: "ssa.gov",
      kind: "Federal - Executive",
      organization: "Social Security Administration",
      state: "MD",
    },
    {
      domain: "va.gov",
      kind: "Federal - Executive",
      organization: "Department of Veterans Affairs",
      suborganization: "Office of IT, Operations",
      state: "DC",
    },
    {
      domain: "ca.gov",
      kind: "State or territory",
      organization: "State of California",
      state: "CA",
    },
  ]);
  expect(JSON.stringify(sites)).not.toContain("@");
});

describe("ownSite", () => {
  const on = (domain: string, kind: string, state?: string) =>
    domainOf(domain, { domain, kind, state })!;
  const ssa = on("ssa.gov", "Federal - Executive", "MD");
  const ca = on("ca.gov", "State or territory", "CA");
  const nv = on("nv.gov", "State or territory", "NV");
  const alameda = on("acgov.gov", "County", "CA");
  const own = (
    jurisdiction: string,
    page: Domain | undefined,
    file: Domain | undefined,
    code = "X-1",
  ) => ownSite({ jurisdiction, code }, page, file);
  /** A page and the file it links, both on one domain. */
  const both = (jurisdiction: string, site: Domain) =>
    own(jurisdiction, site, site);

  test("a page and a file on one domain of the packet's government", () => {
    expect(both("us", ssa)).toBe(true);
    expect(both("us/ca", ca)).toBe(true);
    expect(both("us/ca/alameda", alameda)).toBe(true);
    // An agency with a domain of its own, or on the state's: no path needed.
    expect(both("us/tx", on("txdmv.gov", "State or territory", "TX"))).toBe(
      true,
    );
    expect(both("us/or", on("oregon.gov", "State or territory", "OR"))).toBe(
      true,
    );
    expect(both("us/az", on("navajo-nsn.gov", "Tribal", "AZ"))).toBe(true);
  });

  test("the file has to be on the page's domain, and both in the register", () => {
    expect(own("us", ssa, on("irs.gov", "Federal - Executive", "DC"))).toBe(
      false,
    );
    expect(own("us", ssa, undefined)).toBe(false);
    expect(own("us", undefined, ssa)).toBe(false);
  });

  test("another state's site is not the authority's", () => {
    expect(both("us/ca", nv)).toBe(false);
    // A row kept before the register's state was: nothing is confirmed on it.
    expect(both("us/ca", on("ca.gov", "State or territory"))).toBe(false);
  });

  test("another level of government's site is not the authority's", () => {
    // A county's copy of a state form, a state's of a federal one, and back.
    expect(both("us/ca", alameda)).toBe(false);
    expect(both("us", ca)).toBe(false);
    expect(both("us/ca", ssa)).toBe(false);
    expect(both("us/ca/alameda", ca)).toBe(false);
  });

  test(".mil is federal, each domain its own", () => {
    const army = domainOf("www.armypubs.army.mil");
    expect(army).toEqual({ domain: "army.mil", levels: ["federal"] });
    expect(own("us", army, domainOf("home.army.mil"))).toBe(true);
    expect(own("us", army, domainOf("www.navy.mil"))).toBe(false);
    expect(own("us/va", army, army)).toBe(false);
  });

  test("the GSA's standard and optional forms are on gsa.gov for any federal page", () => {
    const gsa = on("gsa.gov", "Federal - Executive", "DC");
    expect(own("us", ssa, gsa, "SF-180")).toBe(true);
    expect(own("us", ssa, gsa, "OF 306")).toBe(true);
    expect(own("us", ssa, gsa, "SSA-561")).toBe(false);
    expect(own("us/ca", ca, gsa, "SF-180")).toBe(false);
  });
});

test("a host is looked up by the domain it is registered under", async () => {
  const t = initConvexTest();
  await t.mutation(internal.easygov.forms.sites.putSites, {
    sites: parseRegister(csv),
    at: 1,
  });
  expect(
    await t.query(internal.easygov.forms.sites.sitesOf, {
      hosts: ["www.dmv.ca.gov", "www.ssa.gov", "forms.example.gov"],
    }),
  ).toEqual([
    {
      host: "www.dmv.ca.gov",
      domain: "ca.gov",
      kind: "State or territory",
      organization: "State of California",
      state: "CA",
    },
    {
      host: "www.ssa.gov",
      domain: "ssa.gov",
      kind: "Federal - Executive",
      organization: "Social Security Administration",
      state: "MD",
    },
  ]);
  // A domain the register stops listing is forgotten.
  await t.mutation(internal.easygov.forms.sites.putSites, {
    sites: parseRegister(csv).slice(0, 1),
    at: 2,
  });
  expect(
    await t.mutation(internal.easygov.forms.sites.dropSites, { before: 2 }),
  ).toBe(false);
  expect(
    await t.query(internal.easygov.forms.sites.sitesOf, { hosts: ["va.gov"] }),
  ).toEqual([]);
});

test("a government's site kept by hand is looked up as the register would list it", async () => {
  const t = initConvexTest();
  const [row] = await t.query(internal.easygov.forms.sites.sitesOf, {
    hosts: ["www.acgov.org", "www.dmv.org"],
  });
  expect(row).toEqual({
    host: "www.acgov.org",
    domain: "acgov.org",
    kind: "County",
    organization: "Alameda County",
    state: "CA",
  });
  const alameda = domainOf(row.host, row);
  expect(
    ownSite({ jurisdiction: "us/ca/alameda", code: "X-1" }, alameda, alameda),
  ).toBe(true);
  expect(
    ownSite({ jurisdiction: "us/tx/travis", code: "X-1" }, alameda, alameda),
  ).toBe(false);
});
