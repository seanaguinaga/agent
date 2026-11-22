// Whose a government's site is, and what may be read. Every vouched site
// records its owner: a national government, a region of one, or a local body
// (see VOUCHING.md). A site is vouched by CISA's public register of .gov
// domains, which says who each belongs to; by a suffix its country keeps for
// government, with the owner judged once; by a page of its government
// linking it, where the model and something structural both say it is that
// government's; or by a line kept by hand (see `governments.ts`). That
// decides, with nobody's approval, whether a page that links a form and the
// file it links are the packet's government's own (see `confirms`), and
// which addresses are read at all (see `mayRead`).
import { v, type Infer } from "convex/values";
import { getDomain, parse } from "tldts";
import { internal } from "../../_generated/api";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type ActionCtx,
  type QueryCtx,
} from "../../_generated/server";
import type { Decision } from "../decisions";
import { governed, GOVERNMENTS } from "./governments";
import {
  vDeclined,
  vHandKept,
  vLinked,
  vOwner,
  vRegistered,
  vRevoked,
  vSuffixed,
  vSupport,
} from "./schema";

const REGISTER =
  "https://raw.githubusercontent.com/cisagov/dotgov-data/main/current-full.csv";

/** The government a site belongs to. */
export type Owner = Infer<typeof vOwner>;

/** A site as the register vouches for it. */
type Registered = Infer<typeof vRegistered>;

/** What is kept of a site: the register's word, or a judgment of whose. */
const vKept = v.union(vRegistered, vSuffixed, vLinked, vDeclined, vRevoked);
export type Judged =
  | Infer<typeof vSuffixed>
  | Infer<typeof vLinked>
  | Infer<typeof vDeclined>;

/**
 * A site as it stands. Vouched: a government publishes from it, and this is
 * whose it is and what says so. Declined: it was judged a contractor's, or
 * nobody could tell whose. Unjudged: its suffix says it is a government's,
 * and nobody has yet judged which one's. Revoked: a link once vouched for
 * it, and what supported that has gone.
 */
export const vSite = v.union(
  ...vKept.members,
  vHandKept,
  v.object({
    state: v.literal("unjudged"),
    domain: v.string(),
    country: v.string(),
    suffix: v.string(),
  }),
);
export type Site = Infer<typeof vSite>;
export type Unjudged = Extract<Site, { state: "unjudged" }>;
type Vouched = Extract<Site, { state: "vouched" }>;

/**
 * A site nothing is kept of, which a page (`from`) of the vouched site `by`
 * links: with what else says it is that government's, where anything does,
 * and the page of a second of its sites (`also`) where that is what does.
 */
export type Linked = {
  state: "linked";
  domain: string;
  by: Vouched;
  from: string;
  also?: string;
  support?: Infer<typeof vSupport>;
};

/** Whether a site is vouched as this government's. */
export function ownedBy(site: Site | undefined, owner: Owner): boolean {
  const key = (each: Owner) =>
    [
      each.level,
      each.country,
      "region" in each ? each.region : "",
      "body" in each ? each.body : "",
    ].join("|");
  return site?.state === "vouched" && key(site.owner) === key(owner);
}

/**
 * The host of an address that could be read: https, on a public name (not
 * an IP address, nor a private or local name), with no credentials, on the
 * default port. Undefined for any other address.
 */
function publicHost(url: string): string | undefined {
  try {
    const { protocol, hostname, username, password, port } = new URL(url);
    const { isIp, isIcann } = parse(hostname);
    const open =
      protocol === "https:" && !username && !password && !port && !isIp;
    return open && isIcann ? hostname : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a site is a government's own: vouched, or on its suffix. */
function governments(site: Site | undefined): boolean {
  switch (site?.state) {
    case "vouched":
    case "unjudged":
      return true;
    case "declined":
    case "revoked":
    case undefined:
      return false;
  }
}

/**
 * Whether an address may be read: a public https address (see `publicHost`)
 * that is on a government's own site, or that a page on one links or
 * redirects to. `site` is the site the address is on, and `from` the site of
 * the page it was reached from, where it was reached from one. So an
 * address only a search cited, on nobody's site, is never read, and nor is
 * anything two steps from a government's page.
 */
export function mayRead(url: string, site?: Site, from?: Site): boolean {
  return !!publicHost(url) && (governments(site) || governments(from));
}

/** Below this, a judgment of whose a site is is a guess: it vouches nothing. */
const SURE = 0.8;

/** As many links as a vouch may be from a register, suffix or hand site. */
const MAX_STEPS = 2;

/**
 * Whose a site can be judged to be: on a shared suffix, which government's;
 * linked from a government's page, that government's `own` or not.
 */
type Verdict =
  | "national"
  | "local"
  | "own"
  | "contractor"
  | "unsure"
  | `region:${string}`;

/**
 * What a site says of itself (its title and footer), and what the page that
 * links it calls the link: the evidence for whose it is.
 */
export type Evidence = {
  label?: string;
  under?: string;
  title?: string;
  footer?: string;
};

/** The question of whose a site on a government's suffix, or linked, is. */
export function ownerQuestion(site: Unjudged | Linked, evidence: Evidence) {
  const { domain } = site;
  let asks: string;
  let owners: Partial<Record<Verdict, string>>;
  if (site.state === "linked") {
    const { name } = site.by;
    asks = `A page of ${name} (${site.by.domain}) links the site ${domain}. Is it a site of the same government?`;
    owners = {
      own: `A site of the same government as ${name}: its own, or a department or agency of it.`,
    };
  } else {
    const { country, suffix } = site;
    const place = country.toUpperCase();
    const regions =
      GOVERNMENTS.find((each) => each.country === country)?.regions?.split(
        " ",
      ) ?? [];
    asks = `The site ${domain} is on .${suffix}, which ${place} keeps for its governments. Whose site is it?`;
    owners = {
      national: `The national government of ${place}, or a department or agency of it.`,
      ...Object.fromEntries(
        regions.map((code) => [
          `region:${code}`,
          `The government of the region ${place}-${code.toUpperCase()} (ISO 3166-2), or an agency of it.`,
        ]),
      ),
      local: "A local body: a city, county, district or council.",
    };
  }
  return {
    state: { site: domain, ...evidence },
    instructions:
      `${asks} ` +
      "Go by what the site says of itself, and by what the page that links it calls it. " +
      "Choose unsure rather than guess.",
    criteria: {
      ...owners,
      contractor:
        "A contractor, a vendor, or anyone else who is not a government.",
      unsure: "It can't be told from this, or it is a government not listed.",
    } as Record<Verdict, string>,
  };
}

/**
 * What a judgment makes of a site: vouched as the government chosen, where
 * the choice was sure; declined as a contractor's; declined as unsure where
 * it was a guess. Nothing, where the model gave no answer: nothing is kept
 * on no word at all. `name` is what the site calls itself.
 *
 * No vouch rests on the model alone. A linked site that nothing but the
 * link supports, or that is more than `MAX_STEPS` links from a site that
 * needs no link, is declined whatever the model says, and without asking.
 */
export function judged(
  site: Unjudged | Linked,
  name: string,
  decided: Decision<Verdict> | undefined,
): Judged | undefined {
  const { domain } = site;
  const declined = (why: Infer<typeof vDeclined>["why"]) =>
    ({ state: "declined", domain, why }) as const;
  const vouched = { state: "vouched", domain, name } as const;
  if (site.state === "linked") {
    const { by, from, also, support } = site;
    const steps = by.via.kind === "link" ? by.via.steps + 1 : 1;
    if (!support) return declined("unsupported");
    if (steps > MAX_STEPS) return declined("far");
    if (!decided) return undefined;
    if ((decided.confidence ?? 0) < SURE || decided.choice === "unsure") {
      return declined("unsure");
    }
    if (decided.choice === "contractor") return declined("contractor");
    const via = {
      kind: "link" as const,
      from,
      ...(support === "second" && { also }),
      support,
      steps,
    };
    return decided.choice === "own"
      ? { ...vouched, owner: by.owner, via }
      : declined("unsure");
  }
  if (!decided) return undefined;
  const { country, suffix } = site;
  if ((decided.confidence ?? 0) < SURE) return declined("unsure");
  const owned = (owner: Owner) =>
    ({ ...vouched, owner, via: { kind: "suffix", suffix } }) as const;
  const { choice } = decided;
  switch (choice) {
    case "national":
      return owned({ level: "national", country });
    case "local":
      // Which region it is in isn't asked: see VOUCHING.md.
      return owned({ level: "local", country, body: domain });
    case "contractor":
    case "unsure":
      return declined(choice);
    case "own":
      return declined("unsure");
    default:
      return owned({
        level: "region",
        country,
        region: `${country}-${choice.slice("region:".length)}`,
      });
  }
}

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
        state: "vouched" as const,
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
  if (page?.state !== "vouched" || file?.state !== "vouched") return false;
  const [a, b] = [page.owner, file.owner];
  return (
    governs(a, jurisdiction) &&
    governs(b, jurisdiction) &&
    (a.level !== "local" || b.level !== "local" || a.body === b.body)
  );
}

/** As many hosts as are looked up at once. */
const MAX_HOSTS = 50;

const DAY = 24 * 60 * 60 * 1000;

/** As long as a site stays declined before it is judged again. */
const DECLINED_FOR = 30 * DAY;

/** As long as a link vouches for a site before it has to be judged again. */
const LINKED_FOR = 90 * DAY;

/** How long before a link's vouch lapses it is re-checked: twice, weekly. */
const RECHECKED_IN = 14 * DAY;

/** As many link vouches as one weekly run re-checks. */
const RECHECKS = 20;

type LinkedSite = Infer<typeof vLinked>;

/**
 * What a re-check makes of a link's vouch, and when it then dates from.
 * Judged the government's again, it is renewed. Judged not, it is marked
 * once and still stands until it lapses; found so twice in a row, it is
 * revoked. Where nothing could be judged, nothing changes.
 */
export function rechecked(
  held: LinkedSite & { at: number },
  fresh: Judged | undefined,
  now: number,
): { site: Infer<typeof vKept>; at: number } | undefined {
  if (!fresh) return undefined;
  if (fresh.state === "vouched") return { site: fresh, at: now };
  const { at, ...site } = held;
  return held.missed
    ? { site: { state: "revoked", domain: held.domain }, at: now }
    : { site: { ...site, missed: true }, at };
}

/**
 * The site a host is on, as it stands: what its name says (see `governed`),
 * or what is kept for its registrable domain, which the Public Suffix List
 * tells. A site declined long ago, or vouched by a link long ago, is as if
 * never judged. A host on nobody's site has none.
 */
export async function siteOn(
  ctx: QueryCtx,
  url: string,
  now: number,
): Promise<Site | undefined> {
  const host = publicHost(url);
  if (!host) return undefined;
  const named = governed(host);
  if (named?.state === "vouched") return named;
  const domain = getDomain(host);
  const row =
    domain &&
    (await ctx.db
      .query("sites")
      .withIndex("by_domain", (q) => q.eq("domain", domain))
      .unique());
  if (!row) return named;
  const lasts =
    row.state === "declined"
      ? DECLINED_FOR
      : row.state === "vouched" && row.via.kind === "link"
        ? LINKED_FOR
        : Infinity;
  if (row.at < now - lasts) return named;
  const { _id, _creationTime, at: _at, ...site } = row;
  return site;
}

/** The site each of these hosts is on, where it is on one: see `siteOn`. */
export const sitesOf = internalQuery({
  args: { hosts: v.array(v.string()), now: v.number() },
  returns: v.array(v.object({ host: v.string(), site: vSite })),
  handler: async (ctx, { hosts, now }) => {
    const found = await Promise.all(
      hosts.slice(0, MAX_HOSTS).map(async (host) => {
        const site = await siteOn(ctx, `https://${host}/`, now);
        return site ? [{ host, site }] : [];
      }),
    );
    return found.flat();
  },
});

/**
 * The site each of these addresses is on, for an action: none for an
 * address that isn't a public https one.
 */
export async function sitesAt(
  ctx: Pick<ActionCtx, "runQuery">,
  urls: string[],
): Promise<(url: string) => Site | undefined> {
  const hosts = [...new Set(urls.flatMap((url) => publicHost(url) ?? []))];
  const found = await ctx.runQuery(internal.easygov.forms.sites.sitesOf, {
    hosts,
    now: Date.now(),
  });
  const sites = new Map(found.map(({ host, site }) => [host, site]));
  return (url) => sites.get(publicHost(url) ?? "");
}

/**
 * The sites declined or revoked, latest first: what a person reads to
 * decide whether one is owed a hand line.
 *
 *   npx convex run easygov/forms/sites:toReview
 */
export const toReview = internalQuery({
  args: {},
  returns: v.array(
    v.union(
      v.object({ ...vDeclined.fields, at: v.number() }),
      v.object({ ...vRevoked.fields, at: v.number() }),
    ),
  ),
  handler: async (ctx) => {
    const rows = await Promise.all(
      (["revoked", "declined"] as const).map((state) =>
        ctx.db
          .query("sites")
          .withIndex("by_state_and_at", (q) => q.eq("state", state))
          .order("desc")
          .take(100),
      ),
    );
    return rows
      .flat()
      .flatMap(({ _id, _creationTime, ...row }) =>
        row.state === "declined" || row.state === "revoked" ? [row] : [],
      );
  },
});

/** The link vouches about to lapse, soonest first: a bounded batch. */
export const linkedDue = internalQuery({
  args: { now: v.number() },
  returns: v.array(v.object({ ...vLinked.fields, at: v.number() })),
  handler: async (ctx, { now }) => {
    const rows = await ctx.db
      .query("sites")
      .withIndex("by_via_kind_and_at", (q) =>
        q
          .eq("via.kind", "link")
          .gt("at", now - LINKED_FOR)
          .lt("at", now - LINKED_FOR + RECHECKED_IN),
      )
      .take(RECHECKS);
    return rows.flatMap(({ _id, _creationTime, ...row }) =>
      row.state === "vouched" && row.via.kind === "link"
        ? [{ ...row, via: row.via }]
        : [],
    );
  },
});

const registered = (site: { state: string; via?: { kind: string } }) =>
  site.state === "vouched" && site.via?.kind === "register";

/**
 * Keeps what is known of some sites: a batch of the register, or a
 * judgment. New domains are added and changed ones replaced, but the
 * register's word is never replaced by a judgment.
 */
export const putSites = internalMutation({
  args: { sites: v.array(vKept), at: v.number() },
  returns: v.null(),
  handler: async (ctx, { sites, at }) => {
    for (const site of sites) {
      const row = await ctx.db
        .query("sites")
        .withIndex("by_domain", (q) => q.eq("domain", site.domain))
        .unique();
      if (!row) await ctx.db.insert("sites", { ...site, at });
      else if (registered(site) || !registered(row)) {
        await ctx.db.replace("sites", row._id, { ...site, at });
      }
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
      .withIndex("by_via_kind_and_at", (q) =>
        q.eq("via.kind", "register").lt("at", before),
      )
      .take(BATCH);
    for (const row of stale) await ctx.db.delete("sites", row._id);
    return stale.length === BATCH;
  },
});

/** As many domains as are written at once. */
const BATCH = 500;

/**
 * Reads CISA's register and keeps who each .gov domain belongs to, and has
 * the link vouches about to lapse judged again (see `recheckSites`). Run on
 * a schedule (see `crons.ts`), and once to start.
 */
export const importSites = internalAction({
  args: {},
  returns: v.object({ domains: v.number() }),
  handler: async (ctx) => {
    await ctx.scheduler.runAfter(
      0,
      internal.easygov.forms.actions.recheckSites,
      {},
    );
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
