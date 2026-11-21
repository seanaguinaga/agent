// An authority's own sites: what is on them, what may be approved as them,
// and what the pages research read suggest.
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../../_generated/api";
import { initConvexTest } from "../../setup.test";
import {
  authorityKey,
  onSites,
  refusal,
  sharedPublisher,
  suggestedBy,
} from "./authorities";
import type { Registered } from "./sites";

afterEach(() => vi.unstubAllEnvs());

const federal: Registered = {
  domain: "ssa.gov",
  kind: "Federal - Executive",
  organization: "Social Security Administration",
};
const oregon: Registered = {
  domain: "oregon.gov",
  kind: "State or territory",
  organization: "State of Oregon",
};
const california: Registered = {
  domain: "ca.gov",
  kind: "State or territory",
  organization: "State of California",
};
const county: Registered = {
  domain: "alamedacounty.gov",
  kind: "County",
  organization: "Alameda County",
};

describe("onSites", () => {
  test("a domain covers its hosts; a path covers only what is under it", () => {
    const sites = [
      { domain: "ssa.gov" },
      { domain: "oregon.gov", path: "/odot" },
    ];
    expect(onSites("https://www.ssa.gov/forms/ssa-561.pdf", sites)).toBe(true);
    expect(onSites("https://secure.ssa.gov/x.pdf", sites)).toBe(true);
    expect(onSites("https://www.oregon.gov/odot/forms/a.pdf", sites)).toBe(
      true,
    );
    expect(onSites("https://www.oregon.gov/ODOT/Forms/a.pdf", sites)).toBe(
      true,
    );
    // Another Oregon agency on the same domain.
    expect(onSites("https://www.oregon.gov/odhs/a.pdf", sites)).toBe(false);
    expect(onSites("https://www.oregon.gov/odotx/a.pdf", sites)).toBe(false);
    // A name that only ends the same way.
    expect(onSites("https://notssa.gov/a.pdf", sites)).toBe(false);
    expect(onSites("http://www.ssa.gov/a.pdf", sites)).toBe(false);
  });
});

test("GSA's standard and optional forms are every federal agency's", () => {
  expect(sharedPublisher("SF-180", "us")).toEqual([{ domain: "gsa.gov" }]);
  expect(sharedPublisher("OF 306", "us")).toEqual([{ domain: "gsa.gov" }]);
  expect(sharedPublisher("SSA-561", "us")).toEqual([]);
  expect(sharedPublisher("SF-180", "us/ca")).toEqual([]);
});

describe("refusal", () => {
  test("a site of the authority's own level of government is accepted", () => {
    expect(refusal({ domain: "ssa.gov" }, "us", federal)).toBeUndefined();
    expect(refusal({ domain: "whs.mil" }, "us", null)).toBeUndefined();
    expect(
      refusal({ domain: "dmv.ca.gov" }, "us/ca", california),
    ).toBeUndefined();
    expect(
      refusal({ domain: "oregon.gov", path: "/odot" }, "us/or", oregon),
    ).toBeUndefined();
  });

  test("another level's site, a whole state domain, or an unofficial site is refused", () => {
    expect(refusal({ domain: "ssa.gov" }, "us/ca", federal)).toMatch(
      /another level of government/,
    );
    expect(refusal({ domain: "dmv.ca.gov" }, "us", california)).toMatch(
      /another level of government/,
    );
    expect(refusal({ domain: "alamedacounty.gov" }, "us/ca", county)).toMatch(
      /another level of government/,
    );
    expect(refusal({ domain: "whs.mil" }, "us/ca", null)).toMatch(
      /not federal/,
    );
    expect(refusal({ domain: "oregon.gov" }, "us/or", oregon)).toMatch(
      /whole state's domain/,
    );
    expect(refusal({ domain: "forms.com" }, "us", null)).toMatch(
      /not a \.gov or \.mil/,
    );
    expect(refusal({ domain: "made-up.gov" }, "us", null)).toMatch(
      /not in the \.gov register/,
    );
  });
});

test("a page suggests its own site, or the agency's path on a shared state domain", () => {
  expect(suggestedBy("https://www.ssa.gov/forms/", federal)).toEqual({
    domain: "ssa.gov",
  });
  expect(suggestedBy("https://www.dmv.ca.gov/portal/", california)).toEqual({
    domain: "dmv.ca.gov",
  });
  expect(
    suggestedBy("https://www.oregon.gov/ODOT/Forms/Pages/default.aspx", oregon),
  ).toEqual({ domain: "oregon.gov", path: "/odot" });
  expect(suggestedBy("https://www.esd.whs.mil/forms/", null)).toEqual({
    domain: "whs.mil",
  });
  expect(suggestedBy("https://www.oregon.gov/", oregon)).toBeUndefined();
  expect(suggestedBy("https://forms.example.com/", null)).toBeUndefined();
});

test("an operator approves an authority's sites, checked against the register", async () => {
  const t = initConvexTest();
  await t.mutation(internal.easygov.forms.sites.putSites, {
    sites: [oregon],
    at: 0,
  });
  const odot = { jurisdiction: "us/or", authority: "Oregon DMV" };
  const bound = () =>
    t.query(internal.easygov.forms.authorities.boundSites, odot);

  await t.mutation(internal.easygov.forms.authorities.suggestSites, {
    ...odot,
    pages: ["https://www.oregon.gov/odot/dmv/pages/forms.aspx"],
  });
  expect(
    await t.query(api.easygov.forms.authorities.suggestedAuthorities, {}),
  ).toMatchObject([
    { ...odot, sites: [{ domain: "oregon.gov", path: "/odot" }] },
  ]);
  // Suggested isn't approved: nothing is bound yet.
  expect(await bound()).toBeNull();

  await expect(
    t.mutation(api.easygov.forms.authorities.approveSites, {
      ...odot,
      sites: [{ domain: "oregon.gov" }],
    }),
  ).rejects.toThrow(/whole state's domain/);
  await t.mutation(api.easygov.forms.authorities.approveSites, {
    ...odot,
    authority: "  oregon   dmv ",
    sites: [{ domain: "WWW.Oregon.gov", path: "ODOT/" }],
  });
  expect(await bound()).toEqual([{ domain: "oregon.gov", path: "/odot" }]);
  expect(
    await t.query(api.easygov.forms.authorities.suggestedAuthorities, {}),
  ).toEqual([]);
  // Research after approval doesn't change what was approved.
  await t.mutation(internal.easygov.forms.authorities.suggestSites, {
    ...odot,
    pages: ["https://www.oregon.gov/odhs/pages/forms.aspx"],
  });
  expect(await bound()).toEqual([{ domain: "oregon.gov", path: "/odot" }]);
  expect(authorityKey("us/or", " Oregon  DMV")).toBe(
    authorityKey("us/or", "oregon dmv"),
  );

  vi.stubEnv("EASYGOV_OPERATORS", "someone else");
  await expect(
    t.mutation(api.easygov.forms.authorities.approveSites, {
      ...odot,
      sites: [{ domain: "oregon.gov", path: "/odot" }],
    }),
  ).rejects.toThrow(/Operators only/);
});
