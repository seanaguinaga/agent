// Who an official site belongs to. Every .gov domain is registered to a
// verified US government body, listed in CISA's public register: its
// organization, what kind of government it is, and its state. That decides,
// with nobody's approval, whether a page that links a form and the file it
// links are the authority's own (see `ownSite`): both on one registered
// domain, of the packet's level of government and, below federal, its state.
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
  /** The state it is in, as two letters. Absent on a row kept before this was. */
  state?: string;
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
    const sub = row[suborganization]?.trim();
    const where = row[state]?.trim().toUpperCase();
    return [
      {
        domain: name,
        kind: row[kind].trim(),
        organization: row[organization].trim(),
        ...(sub && { suborganization: sub }),
        ...(where && { state: where }),
      },
    ];
  });
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

/** The registered domain a host is on, and whose it can be. */
export type Domain = { domain: string; levels: Level[]; state?: string };

/**
 * The domain a host is on: the one the register lists it under, or, for
 * .mil, which the register doesn't list, its last two labels, federal.
 */
export function domainOf(
  host: string,
  registered?: Pick<Registered, "domain" | "kind" | "state">,
): Domain | undefined {
  const name = host.toLowerCase();
  if (name.endsWith(".mil")) {
    return { domain: name.split(".").slice(-2).join("."), levels: ["federal"] };
  }
  return (
    registered && {
      domain: registered.domain,
      levels: levelsOf(registered.kind),
      state: registered.state,
    }
  );
}

/**
 * Whether a file is on the own site of the authority whose page links the
 * form. The page's domain has to be of the packet's level of government
 * and, below federal, of its state; and the file has to be on that same
 * domain. The one exception is a form one government publishes for others:
 * the GSA's standard and optional forms (SF, OF) are on gsa.gov, whichever
 * federal agency's page links them.
 */
export function ownSite(
  form: { jurisdiction: string; code: string },
  page: Domain | undefined,
  file: Domain | undefined,
): boolean {
  if (!page || !file) return false;
  const level = levelOf(form.jurisdiction);
  const federal = level === "federal";
  const state = form.jurisdiction.split("/")[1]?.toUpperCase();
  return (
    page.levels.includes(level) &&
    (federal || page.state === state) &&
    (file.domain === page.domain ||
      (federal &&
        file.domain === "gsa.gov" &&
        /^(?:SF|OF)[\s-]?\d/i.test(form.code.trim())))
  );
}

const vRegistered = v.object({
  domain: v.string(),
  kind: v.string(),
  organization: v.string(),
  suborganization: v.optional(v.string()),
  state: v.optional(v.string()),
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

/** The register's row for each of these hosts. A host not in the register is left out. */
export const sitesOf = internalQuery({
  args: { hosts: v.array(v.string()) },
  returns: v.array(v.object({ host: v.string(), ...vRegistered.fields })),
  handler: async (ctx, { hosts }) => {
    const found = await Promise.all(
      [...new Set(hosts)].slice(0, MAX_HOSTS).map(async (host) => {
        const registered = await registeredFor(ctx, host);
        if (!registered) return [];
        const { _id, _creationTime, at: _at, ...row } = registered;
        return [{ host, ...row }];
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
