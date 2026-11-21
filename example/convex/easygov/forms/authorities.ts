// Each authority's own sites. A link confirms a file as an authority's form
// only if the page that links it and the file are both on the authority's
// sites. Which sites those are is set once per authority, not per form:
// suggested from the pages research read, and binding once an operator has
// approved them. Until then no form of that authority is given as
// confirmed.
//
// A site is a domain, or, where a state puts every agency on one domain
// ("oregon.gov/odot"), the agency's path there: the whole state domain
// would let any of its agencies' copies confirm a form. An approved site is
// of the authority's own level of government: a federal authority's sites
// are federal domains (or .mil), a state's are its state's, a county's or
// city's are local.
import { ConvexError, v, type Infer } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type QueryCtx,
} from "../../_generated/server";
import { requireOperator } from "../operators";
import { vAuthoritySite } from "./schema";
import { isOfficialHost } from "./sources";
import { registeredFor, siteOf, type Registered } from "./sites";

export type AuthoritySite = Infer<typeof vAuthoritySite>;

/** One key for an authority, however its name is spaced or capitalized. */
export function authorityKey(jurisdiction: string, authority: string): string {
  return `${jurisdiction}|${authority.trim().replace(/\s+/g, " ").toLowerCase()}`;
}

const bareHost = (url: string) =>
  new URL(url).hostname.toLowerCase().replace(/^www\./, "");

/** Whether an address is on one of these sites. */
export function onSites(url: string, sites: AuthoritySite[]): boolean {
  if (!isOfficialHost(url)) return false;
  const host = bareHost(url);
  const path = new URL(url).pathname.toLowerCase();
  return sites.some(
    (site) =>
      (host === site.domain || host.endsWith(`.${site.domain}`)) &&
      (!site.path || path === site.path || path.startsWith(`${site.path}/`)),
  );
}

/**
 * Where a form is published by one government for others: the GSA's
 * standard and optional forms (SF, OF) are every federal agency's, and are
 * on gsa.gov whichever agency's page links them.
 */
export function sharedPublisher(
  code: string,
  jurisdiction: string,
): AuthoritySite[] {
  return levelOf(jurisdiction) === "federal" &&
    /^(?:SF|OF)[\s-]?\d/i.test(code.trim())
    ? [{ domain: "gsa.gov" }]
    : [];
}

type Level = "federal" | "state" | "local";

/** "us" is federal, "us/ca" a state, anything narrower local. */
const levelOf = (jurisdiction: string): Level =>
  (["federal", "state"] as const)[jurisdiction.split("/").length - 1] ??
  "local";

/** The levels of government the register's kind of domain serves. */
function levelsOf(kind: string): Level[] {
  if (kind.startsWith("Federal")) return ["federal"];
  switch (kind) {
    case "State or territory":
      return ["state"];
    case "Interstate":
    case "Tribal":
      return ["state", "local"];
    default:
      // City, County, School district, Special district.
      return ["local"];
  }
}

/** A site written the one way it is kept: lower case, no "www.", no trailing slash. */
function tidy({ domain, path }: AuthoritySite): AuthoritySite {
  const bare = domain
    .trim()
    .toLowerCase()
    .replace(/^www\./, "");
  const under = path
    ?.trim()
    .toLowerCase()
    .replace(/^\/*/, "/")
    .replace(/\/+$/, "");
  return { domain: bare, ...(under && under !== "/" && { path: under }) };
}

/**
 * Why a site can't be one of this authority's, if it can't: it isn't an
 * official domain, isn't in the register, is another level of government's,
 * or is a state's shared domain without the agency's path.
 */
export function refusal(
  site: AuthoritySite,
  jurisdiction: string,
  registered: Registered | null,
): string | undefined {
  const named = site.domain + (site.path ?? "");
  if (!isOfficialHost(`https://${site.domain}/`)) {
    return `${named} is not a .gov or .mil site.`;
  }
  const level = levelOf(jurisdiction);
  if (site.domain.endsWith(".mil")) {
    return level === "federal"
      ? undefined
      : `${named} is a federal site, and this authority is not federal.`;
  }
  if (!registered) return `${named} is not in the .gov register.`;
  if (!levelsOf(registered.kind).includes(level)) {
    return `${named} belongs to ${registered.organization} (${registered.kind}), another level of government.`;
  }
  if (
    registered.kind === "State or territory" &&
    site.domain === registered.domain &&
    !site.path
  ) {
    return `${named} is the whole state's domain: give the agency's path on it, such as ${named}/agency.`;
  }
  return undefined;
}

/**
 * The site a page research read suggests: its own, or, on a state's shared
 * domain, the agency's path there. None for a page that isn't official.
 */
export function suggestedBy(
  url: string,
  registered: Registered | null,
): AuthoritySite | undefined {
  if (!isOfficialHost(url)) return undefined;
  const host = bareHost(url);
  if (host.endsWith(".mil")) {
    return { domain: host.split(".").slice(-2).join(".") };
  }
  if (!registered) return undefined;
  const domain = siteOf(host, registered);
  if (
    registered.kind !== "State or territory" ||
    domain !== registered.domain
  ) {
    return { domain };
  }
  const [first] = new URL(url).pathname.split("/").filter(Boolean);
  return first ? tidy({ domain, path: first }) : undefined;
}

const sameSite = (a: AuthoritySite, b: AuthoritySite) =>
  a.domain === b.domain && a.path === b.path;

const rowFor = (ctx: QueryCtx, key: string) =>
  ctx.db
    .query("authoritySites")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();

/** The authority's approved sites, or null if none are approved yet. */
export const boundSites = internalQuery({
  args: { jurisdiction: v.string(), authority: v.string() },
  returns: v.union(v.null(), v.array(vAuthoritySite)),
  handler: async (ctx, { jurisdiction, authority }) => {
    const row = await rowFor(ctx, authorityKey(jurisdiction, authority));
    return row?.status === "approved" ? row.sites : null;
  },
});

/**
 * Suggests the sites of the pages research read for an authority that has
 * none approved, for an operator to approve. An approved authority is left
 * as it is.
 */
export const suggestSites = internalMutation({
  args: {
    jurisdiction: v.string(),
    authority: v.string(),
    pages: v.array(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { jurisdiction, authority, pages }) => {
    const key = authorityKey(jurisdiction, authority);
    const row = await rowFor(ctx, key);
    if (row?.status === "approved") return null;
    const found = await Promise.all(
      pages
        .filter(isOfficialHost)
        .map(async (page) =>
          suggestedBy(page, await registeredFor(ctx, bareHost(page))),
        ),
    );
    const sites = [
      ...(row?.sites ?? []),
      ...found.flatMap((s) => s ?? []),
    ].filter((site, i, all) => all.findIndex((s) => sameSite(s, site)) === i);
    if (!sites.length) return null;
    const suggested = {
      key,
      jurisdiction,
      authority: row?.authority ?? authority,
      sites,
      status: "suggested" as const,
      suggestedAt: Date.now(),
    };
    if (row) await ctx.db.replace("authoritySites", row._id, suggested);
    else await ctx.db.insert("authoritySites", suggested);
    return null;
  },
});

/** The authorities whose sites are suggested and wait for an operator. */
export const suggestedAuthorities = query({
  args: {},
  returns: v.array(
    v.object({
      jurisdiction: v.string(),
      authority: v.string(),
      sites: v.array(vAuthoritySite),
      suggestedAt: v.number(),
    }),
  ),
  handler: async (ctx) => {
    await requireOperator(ctx);
    const rows = await ctx.db
      .query("authoritySites")
      .withIndex("by_status", (q) => q.eq("status", "suggested"))
      .take(100);
    return rows.flatMap((row) =>
      row.status === "suggested"
        ? [
            {
              jurisdiction: row.jurisdiction,
              authority: row.authority,
              sites: row.sites,
              suggestedAt: row.suggestedAt,
            },
          ]
        : [],
    );
  },
});

/**
 * Approves an authority's sites, in place of any suggested or approved
 * before. Every site has to be the authority's level of government's, and
 * a state's shared domain has to name the agency's path on it.
 */
export const approveSites = mutation({
  args: {
    jurisdiction: v.string(),
    authority: v.string(),
    sites: v.array(vAuthoritySite),
  },
  returns: v.null(),
  handler: async (ctx, { jurisdiction, authority, sites }) => {
    const approvedBy = await requireOperator(ctx);
    const tidied = sites.map(tidy);
    if (!tidied.length) throw new ConvexError("Give at least one site.");
    for (const site of tidied) {
      const why = refusal(
        site,
        jurisdiction,
        await registeredFor(ctx, site.domain),
      );
      if (why) throw new ConvexError(why);
    }
    const key = authorityKey(jurisdiction, authority);
    const row = await rowFor(ctx, key);
    const approved = {
      key,
      jurisdiction,
      authority: authority.trim().replace(/\s+/g, " "),
      sites: tidied.filter(
        (site, i, all) => all.findIndex((s) => sameSite(s, site)) === i,
      ),
      status: "approved" as const,
      approvedAt: Date.now(),
      approvedBy,
    };
    if (row) await ctx.db.replace("authoritySites", row._id, approved);
    else await ctx.db.insert("authoritySites", approved);
    return null;
  },
});
