// Who an official site belongs to, from CISA's register.
import { expect, test } from "vitest";
import { internal } from "../../_generated/api";
import { initConvexTest } from "../../setup.test";
import { parseRegister, siteOf } from "./sites";

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
    },
    {
      domain: "va.gov",
      kind: "Federal - Executive",
      organization: "Department of Veterans Affairs",
      suborganization: "Office of IT, Operations",
    },
    {
      domain: "ca.gov",
      kind: "State or territory",
      organization: "State of California",
    },
  ]);
  expect(JSON.stringify(sites)).not.toContain("@");
});

test("an agency under a state's shared domain has a site of its own", () => {
  const [ssa, , ca] = parseRegister(csv);
  expect(siteOf("www.ssa.gov", ssa)).toBe("ssa.gov");
  expect(siteOf("secure.ssa.gov", ssa)).toBe("ssa.gov");
  expect(siteOf("www.dmv.ca.gov", ca)).toBe("dmv.ca.gov");
  expect(siteOf("courts.ca.gov", ca)).toBe("courts.ca.gov");
  expect(siteOf("www.ca.gov", ca)).toBe("ca.gov");
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
      site: "dmv.ca.gov",
      organization: "State of California",
    },
    {
      host: "www.ssa.gov",
      site: "ssa.gov",
      organization: "Social Security Administration",
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
