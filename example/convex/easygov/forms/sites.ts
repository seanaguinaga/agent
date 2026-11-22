// Whose a government's site is. Every vouched site records its owner: a
// national government, a region of one, or a local body (see VOUCHING.md).
// A site is vouched by CISA's public register of .gov domains, which says
// who each belongs to, or by a line kept by hand (see `HAND`). That decides,
// with nobody's approval, whether a page that links a form and the file it
// links are the packet's government's own (see `confirms`).
import { v, type Infer } from "convex/values";
import { getDomain } from "tldts";
import { internal } from "../../_generated/api";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "../../_generated/server";
import { vOwner, vRegistered } from "./schema";
import { handFor } from "./sources";

const REGISTER =
  "https://raw.githubusercontent.com/cisagov/dotgov-data/main/current-full.csv";

/** The government a site belongs to. */
export type Owner = Infer<typeof vOwner>;

/** A site as the register vouches for it. */
type Registered = Infer<typeof vRegistered>;

/**
 * A site a government publishes from, whose it is, and what vouches for
 * that: an official register, or a line kept by hand with its evidence.
 */
const vSite = v.object({
  ...vRegistered.fields,
  via: v.union(
    vRegistered.fields.via,
    v.object({ kind: v.literal("hand"), note: v.string() }),
  ),
});
export type Site = Infer<typeof vSite>;

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

/** Whose a domain is, from the register's kind of domain. */
function ownerOf(
  kind: string,
  organization: string,
  state?: string,
): Owner | undefined {
  const region = state && `us-${state.toLowerCase()}`;
  if (kind.startsWith("Federal")) return { level: "national", country: "us" };
  switch (kind) {
    case "State or territory":
      // A state's domain the register puts in no state is nobody's.
      return region ? { level: "region", country: "us", region } : undefined;
    case "City":
    case "County":
    case "School district":
    case "Special district":
    case "Tribal":
    case "Interstate":
      return {
        level: "local",
        country: "us",
        ...(region && { region }),
        body: organization,
      };
    default:
      // A kind the register didn't have isn't guessed at: the domain is left
      // out, and the rest of the register is still kept.
      console.warn("The register has a new kind of domain", kind);
      return undefined;
  }
}

/**
 * The domains in the register, from its CSV. Only who each belongs to is
 * kept: never its contacts.
 */
export function parseRegister(csv: string): Registered[] {
  const [header, ...lines] = csv.split(/\r?\n/).filter(Boolean);
  const at = (name: string) => fields(header).indexOf(name);
  const [domain, kind, organization, suborganization, state] = [
    at("Domain name"),
    at("Domain type"),
    at("Organization name"),
    at("Suborganization name"),
    at("State"),
  ];
  if ([domain, kind, organization, state].includes(-1)) {
    throw new Error("The register's columns have changed.");
  }
  return lines.flatMap((line) => {
    const row = fields(line);
    const name = row[domain]?.trim().toLowerCase();
    if (!name?.endsWith(".gov") || !row[organization]) return [];
    const body = row[organization].trim();
    const owner = ownerOf(row[kind].trim(), body, row[state]?.trim());
    if (!owner) return [];
    return [
      {
        domain: name,
        name: row[suborganization]?.trim() || body,
        owner,
        via: { kind: "register" as const, register: "cisa" as const },
      },
    ];
  });
}

/**
 * Whether an owner is a packet's government or one above it: "us" is
 * national, "us/ca" a region, anything narrower local. Which local body a
 * packet is for isn't told from its name: any of its region's is taken.
 */
function governs(owner: Owner, jurisdiction: string): boolean {
  const [country, region, ...local] = jurisdiction.split("/");
  if (owner.country !== country) return false;
  switch (owner.level) {
    case "national":
      return true;
    case "region":
      return owner.region === `${country}-${region}`;
    case "local":
      return local.length > 0 && owner.region === `${country}-${region}`;
  }
}

/**
 * Whether a page and the file it links are the packet's government's own:
 * both on vouched sites, each owned by that government or one above it,
 * and, where both are local, by the same body. So an agency's page confirms
 * a sister agency's file, and a county's page the state's, but never
 * another state's or another county's.
 */
export function confirms(
  jurisdiction: string,
  page: Site | undefined,
  file: Site | undefined,
): boolean {
  if (!page || !file) return false;
  const [a, b] = [page.owner, file.owner];
  return (
    governs(a, jurisdiction) &&
    governs(b, jurisdiction) &&
    (a.level !== "local" || b.level !== "local" || a.body === b.body)
  );
}

/** As many hosts as are looked up at once. */
const MAX_HOSTS = 50;

/**
 * The vouched site each of these hosts is on: its hand-kept line (see
 * `HAND`), or the register's row for its registrable domain, which the
 * Public Suffix List tells. A host on neither is left out.
 */
export const sitesOf = internalQuery({
  args: { hosts: v.array(v.string()) },
  returns: v.array(v.object({ host: v.string(), site: vSite })),
  handler: async (ctx, { hosts }) => {
    const found = await Promise.all(
      [...new Set(hosts)].slice(0, MAX_HOSTS).map(async (host) => {
        const hand = handFor(host);
        if (hand) return [{ host, site: hand }];
        const domain = getDomain(host);
        const row =
          domain &&
          (await ctx.db
            .query("sites")
            .withIndex("by_domain", (q) => q.eq("domain", domain))
            .unique());
        if (!row) return [];
        const { _id, _creationTime, at: _at, ...site } = row;
        return [{ host, site }];
      }),
    );
    return found.flat();
  },
});

/** Keeps a batch of the register: new domains added, changed ones replaced. */
export const putSites = internalMutation({
  args: { sites: v.array(vRegistered), at: v.number() },
  returns: v.null(),
  handler: async (ctx, { sites, at }) => {
    for (const site of sites) {
      const row = await ctx.db
        .query("sites")
        .withIndex("by_domain", (q) => q.eq("domain", site.domain))
        .unique();
      if (row) await ctx.db.replace("sites", row._id, { ...site, at });
      else await ctx.db.insert("sites", { ...site, at });
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
      .query("sites")
      .withIndex("by_at", (q) => q.lt("at", before))
      .take(BATCH);
    for (const row of stale) await ctx.db.delete("sites", row._id);
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
