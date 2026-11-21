// Who an official site belongs to. Every .gov domain is registered to a
// verified US government body, listed in CISA's public register: its
// organization, and what kind of government it is. A host is the
// authority's own only if it is on the authority's site: the domain it
// registered, or, under a state's shared domain ("ca.gov"), the agency's
// own name there ("dmv.ca.gov").
import { v } from "convex/values";
import { internal } from "../../_generated/api";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type QueryCtx,
} from "../../_generated/server";

const REGISTER =
  "https://raw.githubusercontent.com/cisagov/dotgov-data/main/current-full.csv";

/** One registered domain, as the register lists it. */
export type Registered = {
  domain: string;
  kind: string;
  organization: string;
  suborganization?: string;
};

/** The fields of one line of a CSV file, quotes and all. */
function fields(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted && c === '"' && line[i + 1] === '"') {
      field += c;
      i++;
    } else if (c === '"') {
      quoted = !quoted;
    } else if (c === "," && !quoted) {
      out.push(field);
      field = "";
    } else {
      field += c;
    }
  }
  return [...out, field];
}

/**
 * The domains in the register, from its CSV. Only who each belongs to is
 * kept: never its contacts.
 */
export function parseRegister(csv: string): Registered[] {
  const [header, ...lines] = csv.split(/\r?\n/).filter(Boolean);
  const at = (name: string) => fields(header).indexOf(name);
  const [domain, kind, organization, suborganization] = [
    at("Domain name"),
    at("Domain type"),
    at("Organization name"),
    at("Suborganization name"),
  ];
  if ([domain, kind, organization].includes(-1)) {
    throw new Error("The register's columns have changed.");
  }
  return lines.flatMap((line) => {
    const row = fields(line);
    const name = row[domain]?.trim().toLowerCase();
    if (!name?.endsWith(".gov") || !row[organization]) return [];
    const sub = row[suborganization]?.trim();
    return [
      {
        domain: name,
        kind: row[kind].trim(),
        organization: row[organization].trim(),
        ...(sub && { suborganization: sub }),
      },
    ];
  });
}

/**
 * The site a host is on, given the domain it is registered under: that
 * domain, or, under a state's shared domain, the agency's name there.
 */
export function siteOf(host: string, registered: Registered): string {
  const labels = host
    .toLowerCase()
    .replace(/^www\./, "")
    .split(".");
  const own = registered.domain.split(".").length;
  const shared = registered.kind === "State or territory";
  return labels
    .slice(-(shared && labels.length > own ? own + 1 : own))
    .join(".");
}

const vSite = v.object({
  host: v.string(),
  /** The authority's site the host is on: see `siteOf`. */
  site: v.string(),
  organization: v.string(),
});

/** The registered domain a host is under, if it is in the register. */
async function registeredFor(ctx: QueryCtx, host: string) {
  const labels = host.toLowerCase().split(".");
  // A registered .gov domain is the host's last two labels.
  const domain = labels.slice(-2).join(".");
  return await ctx.db
    .query("officialSites")
    .withIndex("by_domain", (q) => q.eq("domain", domain))
    .unique();
}

/** As many hosts as are looked up at once. */
const MAX_HOSTS = 50;

/** Whose site each of these hosts is on. A host not in the register is left out. */
export const sitesOf = internalQuery({
  args: { hosts: v.array(v.string()) },
  returns: v.array(vSite),
  handler: async (ctx, { hosts }) => {
    const found = await Promise.all(
      [...new Set(hosts)].slice(0, MAX_HOSTS).map(async (host) => {
        const registered = await registeredFor(ctx, host);
        return registered
          ? [
              {
                host,
                site: siteOf(host, registered),
                organization:
                  registered.suborganization ?? registered.organization,
              },
            ]
          : [];
      }),
    );
    return found.flat();
  },
});

const vRegistered = v.object({
  domain: v.string(),
  kind: v.string(),
  organization: v.string(),
  suborganization: v.optional(v.string()),
});

/** Keeps a batch of the register: new domains added, changed ones replaced. */
export const putSites = internalMutation({
  args: { sites: v.array(vRegistered), at: v.number() },
  returns: v.null(),
  handler: async (ctx, { sites, at }) => {
    for (const site of sites) {
      const row = await ctx.db
        .query("officialSites")
        .withIndex("by_domain", (q) => q.eq("domain", site.domain))
        .unique();
      if (row) await ctx.db.replace("officialSites", row._id, { ...site, at });
      else await ctx.db.insert("officialSites", { ...site, at });
    }
    return null;
  },
});

/** Forgets a batch of domains the register no longer lists. */
export const dropSites = internalMutation({
  args: { before: v.number() },
  returns: v.boolean(),
  handler: async (ctx, { before }) => {
    const stale = await ctx.db
      .query("officialSites")
      .withIndex("by_at", (q) => q.lt("at", before))
      .take(BATCH);
    for (const row of stale) await ctx.db.delete("officialSites", row._id);
    return stale.length === BATCH;
  },
});

/** As many domains as are written at once. */
const BATCH = 500;

/**
 * Reads CISA's register and keeps who each .gov domain belongs to. Run on a
 * schedule (see `crons.ts`), and once to start.
 */
export const importSites = internalAction({
  args: {},
  returns: v.object({ domains: v.number() }),
  handler: async (ctx) => {
    const response = await fetch(REGISTER, {
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      throw new Error(`The register answered ${response.status}.`);
    }
    const sites = parseRegister(await response.text());
    // A register that came back nearly empty is a broken download, not a
    // country without governments: nothing is forgotten on its word.
    if (sites.length < 1000) {
      throw new Error(`The register listed only ${sites.length} domains.`);
    }
    const at = Date.now();
    for (let i = 0; i < sites.length; i += BATCH) {
      await ctx.runMutation(internal.easygov.forms.sites.putSites, {
        sites: sites.slice(i, i + BATCH),
        at,
      });
    }
    while (
      await ctx.runMutation(internal.easygov.forms.sites.dropSites, {
        before: at,
      })
    );
    return { domains: sites.length };
  },
});
