"use node";
// The PDF work: fetching a form from its authority, reading it, and filling
// it. In Node because the PDF libraries need it.
import { requireOperator } from "../operators";
import { sha256 as sha256Of } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { ConvexError, v, type Infer } from "convex/values";
import { PDFCheckBox, PDFDocument, PDFTextField } from "pdf-lib";
import { getDomain } from "tldts";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import {
  action,
  internalAction,
  type ActionCtx,
} from "../../_generated/server";
import {
  BrowserBusy,
  browserService,
  openViaBrowser,
  type Opened,
} from "./browser";
import { decide } from "../decisions";
import { resolveMapping } from "./mapping";
import { openForFilling, UnusablePdf } from "./open";
import { fillPdf, inspectPdf, verifyPdf } from "./pdf";
import {
  expiredBy,
  languageOf,
  revisionOf,
  type FormFacts,
  type ReadFacts,
} from "./facts";
import {
  vAddressAnswer,
  vFilledDocument,
  vFormFacts,
  vNamedBy,
  vPageLink,
  vLeft,
  vTarget,
  vMapping,
  vPacketPdf,
} from "./schema";
import {
  judged,
  mayRead,
  ownedBy,
  ownerQuestion,
  rechecked,
  sitesAt,
  vSite,
  type Evidence,
  type Judged,
  type Linked,
  type Unjudged,
} from "./sites";
import {
  addressKey,
  isWebPage,
  labelledLinks,
  MAX_BYTES,
  namedBy,
  notAPdf,
  type NamedBy,
  readUpTo,
  selfDescribed,
  stands,
  type PageLink,
} from "./sources";
import { fileWords, worthReading } from "./reader";
import { costRead, openingOf, type Words } from "./words";

// --- Asking an official address ---------------------------------------------
//
// An address is read only if it may be (see `mayRead`): it is on a
// government's own site, or a page on one links or redirects to it. Every
// fetch goes through `ask`: a case finding its forms, a case reading a
// page for its links, and an operator fetching a registry entry. What an
// address answered is kept (`formAddresses`), a file is known by its hash
// wherever it came from, and each ask says what it cost.

const vCost = v.object({
  downloads: v.number(),
  browser: v.number(),
  pages: v.number(),
  bytes: v.number(),
  held: v.number(),
  reused: v.number(),
  unchanged: v.number(),
  /** Files with no words of their own given to a reader: see `reader.ts`. */
  reads: v.number(),
});
type AskCost = Infer<typeof vCost>;

/**
 * Why an ask got nothing. What an address answers (see `vAddressAnswer`),
 * or: "page", it is a web page and a file was wanted; "otherForm", its file
 * isn't the form; "refused", a plain request was turned away, and a browser
 * may do better; "busy", no browser could be had; "unspent", it would have
 * cost something, and the caller said not to spend.
 */
const vWhyNot = v.union(
  v.literal("gone"),
  v.literal("unreachable"),
  v.literal("unusable"),
  v.literal("page"),
  v.literal("otherForm"),
  v.literal("refused"),
  v.literal("busy"),
  v.literal("unspent"),
);
const vNo = v.object({
  ok: v.literal(false),
  why: vWhyNot,
  note: v.string(),
  cost: vCost,
});

const askArgs = {
  url: v.string(),
  /** A plain request, or the hosted browser: the caller pays for each. */
  way: v.union(v.literal("request"), v.literal("browser")),
  /** False to answer only from what is held, spending nothing. */
  spend: v.boolean(),
  /** The page that links the address, where it was come by from one. */
  from: v.optional(v.string()),
};
type Ask = {
  url: string;
  from?: string;
  way: "request" | "browser";
  spend: boolean;
  /** The form the address is wanted as. Without one, it is wanted as a page. */
  form?: {
    code: string;
    jurisdiction: string;
    /** The page's words for its link here, if it links it as the form. */
    linkedAs?: string;
    /** Whether that link may stand for a file with no words: see `namedBy`. */
    trusted?: boolean;
    /** The registry entry a new file belongs to. */
    formId?: Id<"forms">;
  };
  /** The caller's packet: what it has asked already isn't asked again. */
  packet?: string;
  /** True to ask even where a failure still stands. */
  again?: boolean;
  /** True if a read may be spent on a file with no words of its own. */
  read?: boolean;
};
type Asked =
  | {
      ok: true;
      file: {
        editionId: Id<"formEditions">;
        facts: FormFacts;
        namedBy: NamedBy;
      };
      cost: AskCost;
    }
  | { ok: true; links: PageLink[]; cost: AskCost }
  | Infer<typeof vNo>;
type AddressAnswer = Infer<typeof vAddressAnswer>;

/** As much of a page as is read for its links. */
const MAX_PAGE = 2_000_000;

/** The site an address is on, by its name alone: its registrable domain. */
const domainOf = (url: string) => getDomain(new URL(url).hostname);

/**
 * How the page `from`, as it was last read, leads to a site: by the address
 * there that it links, or that a redirect had it served from. Undefined
 * where it doesn't, or was never read: nobody's word is taken for what a
 * page links.
 */
async function leadsTo(ctx: ActionCtx, from: string, site: string | null) {
  const held = await ctx.runQuery(internal.easygov.forms.data.addressOf, {
    key: addressKey(from),
  });
  if (held?.outcome !== "page" || !site) return undefined;
  if (held.at && domainOf(held.at) === site) {
    return { by: "redirect" as const, url: held.at };
  }
  const link = held.links.find(({ url }) => domainOf(url) === site);
  return link && { by: "link" as const, url: link.url };
}

/**
 * Whether an address may be read, reached from `from` if at all: a page
 * that was read and leads to it (see `leadsTo`), or the address a redirect
 * to it was seen to come from.
 */
async function readable(
  ctx: ActionCtx,
  url: string,
  from?: string,
  redirected = false,
) {
  const on = await sitesAt(ctx, [url, ...(from ? [from] : [])]);
  if (mayRead(url, on(url))) return true;
  return (
    !!from &&
    mayRead(url, on(url), on(from)) &&
    (redirected || !!(await leadsTo(ctx, from, domainOf(url))))
  );
}

/**
 * One plain request, following redirects only where each may be read: onto
 * a government's own site, or one step from one.
 */
async function request(
  ctx: ActionCtx,
  url: string,
  from: string | undefined,
  ms: number,
  /** The most bytes taken: a body longer than this is cut there. */
  limit: number,
  held?: { etag?: string; lastModified?: string },
): Promise<
  | {
      got: "body";
      bytes: Uint8Array;
      /** Whether the body was longer than `limit`, and cut. */
      cut: boolean;
      /** Where the request ended up, after any redirects. */
      at: string;
      /** Whether the server says it is a web page. */
      html: boolean;
      etag?: string;
      lastModified?: string;
    }
  | { got: "unchanged" | "gone" | "refused" | "unusable"; note: string }
> {
  let address = url;
  const signal = AbortSignal.timeout(ms);
  try {
    for (let redirects = 0; redirects <= 5; redirects++) {
      if (!(await readable(ctx, address, from, redirects > 0))) {
        return {
          got: "unusable",
          note: "The form link left the authority’s permitted sites.",
        };
      }
      const response = await fetch(address, {
        redirect: "manual",
        signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; form-fetch)",
          ...(held?.etag && { "If-None-Match": held.etag }),
          ...(held?.lastModified && { "If-Modified-Since": held.lastModified }),
        },
      });
      const { status } = response;
      if (status === 304) return { got: "unchanged", note: "" };
      if (status >= 300 && status < 400 && response.headers.has("location")) {
        const next = new URL(response.headers.get("location")!, address).href;
        // A redirect within a site is no step further from a government's.
        if (domainOf(next) !== domainOf(address)) from = address;
        address = next;
        continue;
      }
      // Gone is gone; anything else is the site turning the request away.
      if (status === 404 || status === 410) {
        return { got: "gone", note: `The source answered ${status}.` };
      }
      if (!response.ok) {
        return { got: "refused", note: `The source answered ${status}.` };
      }
      return {
        got: "body",
        ...(await readUpTo(response, limit)),
        at: address,
        html: /html/i.test(response.headers.get("content-type") ?? ""),
        etag: response.headers.get("etag") ?? undefined,
        lastModified: response.headers.get("last-modified") ?? undefined,
      };
    }
    return {
      got: "unusable",
      note: "The form link redirected too many times.",
    };
  } catch (error) {
    // No answer at all: nothing was learned about the address.
    return {
      got: "refused",
      note: `The request failed: ${error}`.slice(0, 200),
    };
  }
}

/** A place among the browsers all cases share, waiting a little for one. */
async function browserLease(ctx: ActionCtx) {
  for (let tries = 0; tries < 5; tries++) {
    const lease = await ctx
      .runMutation(internal.easygov.forms.data.takeBrowserLease, {})
      .catch(() => null);
    if (lease) return lease;
    await new Promise((turn) => setTimeout(turn, 2000 + Math.random() * 2000));
  }
  return null;
}

/** As many links of each kind as are kept from a page. */
const MAX_LINKS = 200;

/** The links worth keeping from a page: those that may be read, PDFs first. */
async function linksWorthKeeping(ctx: ActionCtx, html: string, page: string) {
  const all = labelledLinks(html.slice(0, MAX_PAGE), page).filter(
    ({ url }) => url.length <= 500,
  );
  const on = await sitesAt(ctx, [page, ...all.map(({ url }) => url)]);
  // A page keeps the links to its own site whoever's it is: they are read
  // only once the site is vouched, and a vouch mustn't wait on a new read.
  const links = all.filter(
    ({ url }) =>
      mayRead(url, on(url), on(page)) ||
      (!!domainOf(url) && domainOf(url) === domainOf(page)),
  );
  return [
    ...links.filter(({ pdf }) => pdf).slice(0, MAX_LINKS),
    ...links.filter(({ pdf }) => !pdf).slice(0, MAX_LINKS),
  ];
}

/** What a file says about itself now: as read, and whether it has expired. */
const factsNow = (words: Words, facts: ReadFacts): FormFacts => ({
  ...facts,
  ...(expiredBy(openingOf(words), Date.now()) && { expired: true }),
});

/**
 * What an official address serves: a form's file, or a page's links. What
 * it answered before is used first (see `stands`); a file is asked for
 * again only so the server can say it hasn't changed. New bytes are known by
 * their hash, so a file held from another address isn't read or kept twice.
 * Whether a file has expired is worked out each time it is given, from what
 * it prints: never kept, so it can't go stale.
 */
async function ask(
  ctx: ActionCtx,
  { url, from, way, spend, form, packet, again, read = false }: Ask,
): Promise<Asked> {
  const cost = {
    downloads: 0,
    browser: 0,
    pages: 0,
    bytes: 0,
    held: 0,
    reused: 0,
    unchanged: 0,
    reads: 0,
  };
  const no = (why: Infer<typeof vWhyNot>, note: string) =>
    ({ ok: false, why, note, cost }) as const;
  if (!(await readable(ctx, url, from))) {
    return no("unusable", "Not a government’s own site, nor linked from one.");
  }
  const key = addressKey(url);
  const held = await ctx.runQuery(internal.easygov.forms.data.addressOf, {
    key,
  });
  if (held) cost.held++;
  const keep = (answer: AddressAnswer) =>
    ctx.runMutation(internal.easygov.forms.data.recordAddress, {
      key,
      url,
      packet,
      answer,
    });
  /** A file as the form it is wanted as. Undefined: it has yet to be kept. */
  const asFile = (file: {
    words: Words;
    facts: ReadFacts;
    editionId?: Id<"formEditions">;
  }): Asked | undefined => {
    if (!form) return no("unusable", "It isn't a web page.");
    const { editionId, words } = file;
    const named = namedBy(form.code, words, form.linkedAs, form.trusted);
    if (!named) {
      return no(
        "otherForm",
        words.from === "none"
          ? `The file has no words to read, and no trusted link names it ${form.code}.`
          : `The file doesn't name ${form.code}.`,
      );
    }
    const facts = factsNow(words, file.facts);
    return editionId
      ? { ok: true, file: { editionId, facts, namedBy: named }, cost }
      : undefined;
  };
  const asPage = (links: PageLink[]): Asked =>
    form ? no("page", "It is a web page.") : { ok: true, links, cost };

  const mine = !!packet && held?.packet === packet;
  if (held && (mine || (!again && stands(held, Date.now())))) {
    const answer =
      held.outcome === "file"
        ? asFile(held)
        : held.outcome === "page"
          ? asPage(held.links)
          : no(held.outcome, held.note);
    if (answer) {
      cost.reused++;
      return answer;
    }
  }
  if (!spend) return no("unspent", "");

  let got: { bytes: Uint8Array; at: string; html: boolean };
  let etag: string | undefined;
  let lastModified: string | undefined;
  if (way === "request") {
    cost[form ? "downloads" : "pages"]++;
    // Only a file that is still kept can be told "the same as before", and
    // one whose words are still to be read is wanted whole.
    const kept =
      held?.outcome === "file" &&
      held.editionId &&
      !worthReading(held.words, read)
        ? held
        : undefined;
    const answered = await request(
      ctx,
      url,
      from,
      form ? 45_000 : 15_000,
      form ? MAX_BYTES : MAX_PAGE,
      form && kept,
    );
    if (answered.got === "unchanged" && kept) {
      cost.unchanged++;
      const {
        url: _url,
        checkedAt: _at,
        failures: _n,
        packet: _p,
        ...same
      } = kept;
      await keep(same);
      return asFile(kept) ?? no("unusable", "The file isn't kept.");
    }
    if (answered.got === "gone" || answered.got === "unusable") {
      await keep({ outcome: answered.got, note: answered.note });
      return no(answered.got, answered.note);
    }
    if (answered.got !== "body") return no("refused", answered.note);
    if (answered.cut && !answered.html) {
      const note = "The file is too large.";
      await keep({ outcome: "unusable", note });
      return no("unusable", note);
    }
    ({ etag, lastModified } = answered);
    got = answered;
  } else {
    const service = browserService();
    if (!service) return no("busy", "No browser is set up.");
    const leaseId = await browserLease(ctx);
    if (!leaseId) return no("busy", "Every browser is in use.");
    let opened: Opened;
    try {
      cost.browser++;
      opened = await openViaBrowser(url, service);
    } catch (error) {
      if (error instanceof BrowserBusy) return no("busy", error.message);
      const note = `${error instanceof Error ? error.message : error}`.slice(
        0,
        200,
      );
      await keep({ outcome: "unreachable", note });
      return no("unreachable", note);
    } finally {
      await ctx
        .runMutation(internal.easygov.forms.data.releaseBrowserLease, {
          leaseId,
        })
        .catch(() => undefined);
    }
    // Where the browser ended up is one redirect from where it was sent.
    if (
      opened.got === "page" &&
      new URL(opened.at).host !== new URL(url).host &&
      !(await readable(ctx, opened.at, url, true))
    ) {
      const note = "The page left the authority’s permitted sites.";
      await keep({ outcome: "unusable", note });
      return no("unusable", note);
    }
    got =
      opened.got === "file"
        ? { bytes: opened.bytes, at: url, html: false }
        : {
            bytes: new TextEncoder().encode(opened.html),
            at: opened.at,
            html: true,
          };
  }
  const { bytes, at, html } = got;

  const problem = notAPdf(bytes);
  if (problem) {
    if (!html && !isWebPage(bytes)) {
      await keep({ outcome: "unusable", note: problem });
      return no("unusable", problem);
    }
    // A page is read for its links, not downloaded from. Its links are
    // relative to where it was served from.
    const links = await linksWorthKeeping(
      ctx,
      new TextDecoder().decode(bytes),
      at,
    );
    const moved = new URL(at).host !== new URL(url).host;
    await keep({ outcome: "page", links, ...(moved && { at }) });
    return asPage(links);
  }
  if (!form) return no("unusable", "It isn't a web page.");
  cost.bytes += bytes.length;

  const sha256 = bytesToHex(sha256Of(bytes));
  const known = await ctx.runMutation(internal.easygov.forms.data.keepFile, {
    sha256,
  });
  if (known.words && known.facts && !worthReading(known.words, read)) {
    // The same bytes as before: nothing to read again.
    const { words, facts } = known;
    const answer = asFile({ words, facts, editionId: known.editionId });
    if (answer) {
      await keep({
        outcome: "file",
        sha256,
        etag,
        lastModified,
        words,
        facts,
        editionId: known.editionId,
      });
      return answer;
    }
  }
  // Many forms are protected without a password. Where the file allows its
  // forms to be filled, it's opened.
  let ready: Uint8Array;
  let opened: boolean;
  try {
    ({ bytes: ready, opened } = await openForFilling(bytes));
  } catch (error) {
    const why =
      error instanceof UnusablePdf ? error.message : "It can't be read.";
    await keep({ outcome: "unusable", note: why });
    return no("unusable", why);
  }
  const { pages, edition, fillable, targets, ...own } = await inspectPdf(ready);
  const words = await fileWords(ctx, { ...own, pdf: ready }, read);
  if (costRead(words)) cost.reads++;
  const opening = openingOf(words);
  const facts: ReadFacts = {
    pages,
    // A place is known by the words printed beside it on its page.
    places: words.from === "text" ? targets.length : 0,
    language: languageOf(opening),
    revision: revisionOf(`${edition ?? ""} ${opening}`),
  };
  // Whatever way it came, it has to be the form it's meant to be. A file
  // that isn't is still known for what it is, and isn't kept.
  let { editionId } = known;
  if (namedBy(form.code, words, form.linkedAs, form.trusted) && !editionId) {
    // What's kept is the form ready to fill. Its identity is still the hash
    // of the bytes as the authority published them.
    const storageId = await ctx.storage.store(
      new Blob([ready.slice().buffer], { type: "application/pdf" }),
    );
    const file = await ctx.runMutation(internal.easygov.forms.data.keepFile, {
      sha256,
      fresh: {
        formId: form.formId,
        sourceUrl: url,
        code: form.code,
        jurisdiction: form.jurisdiction,
        edition: {
          storageId,
          edition,
          pages,
          fillable,
          targets,
          obtained: { via: way, url },
          opened,
        },
      },
    });
    // Another address served the same bytes a moment ago: its copy stands.
    if (!file.kept) await ctx.storage.delete(storageId);
    ({ editionId } = file);
  }
  await keep({
    outcome: "file",
    sha256,
    etag,
    lastModified,
    words,
    facts,
    editionId,
  });
  // Not the form, or kept just now: either way there is an answer.
  return asFile({ words, facts, editionId })!;
}

const vFileAnswer = v.union(
  v.object({
    ok: v.literal(true),
    editionId: v.id("formEditions"),
    facts: vFormFacts,
    namedBy: vNamedBy,
    cost: vCost,
  }),
  vNo,
);
export type FileAnswer = Infer<typeof vFileAnswer>;

/** The file at an address, as the form `code`: see `ask`. */
export const fetchFile = internalAction({
  args: {
    ...askArgs,
    code: v.string(),
    jurisdiction: v.string(),
    linkedAs: v.optional(v.string()),
    trusted: v.optional(v.boolean()),
    packet: v.optional(v.string()),
    /** True if a read may be spent on a file with no words of its own. */
    read: v.optional(v.boolean()),
  },
  returns: vFileAnswer,
  handler: async (
    ctx,
    { url, from, way, spend, packet, read, ...form },
  ): Promise<FileAnswer> => {
    const asked = { url, from, way, spend, packet, read, form };
    const answer = await ask(ctx, asked);
    if (!answer.ok) return answer;
    if (!("file" in answer)) throw new Error("A form was asked for");
    return { ok: true, ...answer.file, cost: answer.cost };
  },
});

const vLinksAnswer = v.union(
  v.object({ ok: v.literal(true), links: v.array(vPageLink), cost: vCost }),
  vNo,
);
export type LinksAnswer = Infer<typeof vLinksAnswer>;

/** The links an official page carries, with the page's words: see `ask`. */
export const readLinks = internalAction({
  args: { ...askArgs, packet: v.optional(v.string()) },
  returns: vLinksAnswer,
  handler: async (ctx, args): Promise<LinksAnswer> => {
    const answer = await ask(ctx, args);
    if (!answer.ok) return answer;
    if (!("links" in answer)) throw new Error("A page was asked for");
    return answer;
  },
});

/**
 * What, beyond the link, says a linked site is its government's (see
 * `vSupport`), from its front page and the pages said to link it. Nothing,
 * where the page said to link it doesn't lead to it.
 */
async function supportFor(
  ctx: ActionCtx,
  { domain, by, from, also }: Linked,
  html: string,
): Promise<Linked["support"]> {
  const led = await leadsTo(ctx, from, domain);
  if (led?.by !== "link") return led?.by;
  const hosts = labelledLinks(html, led.url).map(
    (link) => `https://${new URL(link.url).hostname}/`,
  );
  const on = await sitesAt(ctx, [...(also ? [also] : []), ...hosts]);
  if (hosts.some((host) => ownedBy(on(host), by.owner))) return "back";
  const second = also && on(also);
  return second &&
    second.domain !== by.domain &&
    ownedBy(second, by.owner) &&
    (await leadsTo(ctx, also, domain))
    ? "second"
    : undefined;
}

/**
 * Whose a site is (see `judged`): a site on a government's suffix, or one
 * a vouched site's page leads to. The front page of the host at `url` is
 * read for what the site says of itself and, for a linked site, for what
 * supports it: it links back to a site of the same government, a second
 * such site's page links it, or a redirect from the government's host led
 * to it. The decision model is asked with that and with what the linking
 * page calls the link, where its answer could vouch. Nothing, where the
 * model gave no answer or, checking `again`, the front page couldn't be
 * read: a site isn't struck for being down.
 */
async function judge(
  ctx: ActionCtx,
  candidate: Unjudged | Linked,
  url: string,
  link: Evidence,
  again = false,
): Promise<Judged | undefined> {
  const front = await request(
    ctx,
    new URL("/", url).href,
    candidate.state === "linked" ? candidate.from : undefined,
    15_000,
    MAX_PAGE,
  );
  if (again && front.got !== "body") return undefined;
  const html =
    front.got === "body" ? new TextDecoder().decode(front.bytes) : "";
  const says = selfDescribed(html);
  const site =
    candidate.state === "linked"
      ? { ...candidate, support: await supportFor(ctx, candidate, html) }
      : candidate;
  const name = says.title ?? site.domain;
  return (
    judged(site, name, undefined) ??
    judged(
      site,
      name,
      await decide(ctx, ownerQuestion(site, { ...link, ...says })),
    )
  );
}

/**
 * Judges whose a site is, once, and keeps the answer (see `judge`): a site
 * on a government's suffix, or one nothing is kept of that the page `from`,
 * on a vouched site, leads to; `also` is a page of a second site that links
 * it, and `label` and `under` what the linking page calls the link. Gives
 * the site as it then stands.
 */
export const judgeSite = internalAction({
  args: {
    url: v.string(),
    label: v.optional(v.string()),
    under: v.optional(v.string()),
    from: v.optional(v.string()),
    also: v.optional(v.string()),
  },
  returns: v.union(vSite, v.null()),
  handler: async (ctx, { url, from, also, ...link }) => {
    const on = await sitesAt(ctx, [url, ...(from ? [from] : [])]);
    const [site, by, domain] = [on(url), from && on(from), domainOf(url)];
    const candidate =
      site?.state === "unjudged"
        ? site
        : !site && by && by.state === "vouched" && from && domain
          ? { state: "linked" as const, domain, by, from, also }
          : undefined;
    const kept = candidate && (await judge(ctx, candidate, url, link));
    if (!kept) return site ?? null;
    await ctx.runMutation(internal.easygov.forms.sites.putSites, {
      sites: [kept],
      at: Date.now(),
    });
    return kept;
  },
});

/**
 * Judges again the link vouches about to lapse (see `linkedDue`): a batch
 * of bounded size, each for a few plain requests and at most one question
 * to the decision model. The pages that linked the site are asked again
 * first; one that can't be asked stands as it was last read. See
 * `rechecked` for what becomes of the vouch.
 */
export const recheckSites = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();
    const due = await ctx.runQuery(internal.easygov.forms.sites.linkedDue, {
      now,
    });
    for (const held of due) {
      // What a slow run doesn't reach waits for the next.
      if (Date.now() - now > 5 * 60_000) break;
      const { domain } = held;
      const { from, also } = held.via;
      for (const url of [from, ...(also ? [also] : [])]) {
        await ask(ctx, { url, way: "request", spend: true, again: true });
      }
      const by = (await sitesAt(ctx, [from]))(from);
      // A voucher whose own vouch has lapsed says nothing either way.
      if (!by) continue;
      const led = await leadsTo(ctx, from, domain);
      const fresh =
        by.state === "vouched" && led
          ? await judge(
              ctx,
              { state: "linked", domain, by, from, also },
              led.url,
              {},
              true,
            )
          : ({ state: "declined", domain, why: "unsupported" } as const);
      const next = rechecked(held, fresh, now);
      if (!next) continue;
      await ctx.runMutation(internal.easygov.forms.sites.putSites, {
        sites: [next.site],
        at: next.at,
      });
    }
    return null;
  },
});

/**
 * Fetches a registry entry's form from its source, for an operator: each of
 * its addresses by a plain request, then by a browser where that was
 * refused. Keeps how every try went.
 */
export const fetchForm = action({
  args: { formId: v.id("forms") },
  returns: v.object({ editionId: v.id("formEditions") }),
  handler: async (ctx, { formId }) => {
    await requireOperator(ctx);
    const form = await ctx.runQuery(internal.easygov.forms.data.formOf, {
      formId,
    });
    if (!form) throw new ConvexError("Form not found.");
    const { urls, code, jurisdiction } = form;
    const attempts: {
      via: "request" | "browser";
      url: string;
      ok: boolean;
      note: string;
    }[] = [];
    const record = (ok: boolean) =>
      ctx.runMutation(internal.easygov.forms.data.recordAttempts, {
        formId,
        ok,
        attempts,
      });
    const refused = new Set<string>();
    for (const way of ["request", "browser"] as const) {
      for (const url of way === "request" ? urls : [...refused]) {
        const answer = await ask(ctx, {
          url,
          way,
          spend: true,
          again: true,
          read: true,
          form: { code, jurisdiction, formId },
        });
        const ok = answer.ok && "file" in answer;
        attempts.push({
          via: way,
          url,
          ok,
          note: answer.ok ? "" : answer.note,
        });
        if (answer.ok && "file" in answer) {
          await record(true);
          return { editionId: answer.file.editionId };
        }
        if (!answer.ok && answer.why === "refused") refused.add(url);
      }
    }
    await record(false);
    throw new ConvexError(
      `The form couldn't be fetched. ${attempts.at(-1)?.note ?? ""}`,
    );
  },
});

type Filled = typeof vFilledDocument.type;

/** Fills an edition with answers, checks the result, and stores it. */
async function fill(
  ctx: ActionCtx,
  editionId: Id<"formEditions">,
  answers: Record<string, string>,
  needReviewed: boolean,
): Promise<Filled> {
  const input = await ctx.runQuery(internal.easygov.forms.data.fillInput, {
    editionId,
  });
  if (needReviewed && !input.reviewed) {
    throw new ConvexError("This form's mapping hasn't been reviewed yet.");
  }
  return writeDocument(ctx, input, answers);
}
async function writeDocument(
  ctx: ActionCtx,
  input: {
    storageId: Id<"_storage">;
    targets: Infer<typeof vTarget>[];
    mapping: Infer<typeof vMapping>;
  },
  answers: Record<string, string>,
): Promise<Filled> {
  const blank = await ctx.storage.get(input.storageId);
  if (!blank) throw new Error("The blank form is missing");
  const kinds = Object.fromEntries(
    input.targets.map((target) => [target.id, target.kind]),
  );
  const { values, toComplete } = resolveMapping(input.mapping, kinds, answers);
  const bytes = new Uint8Array(await blank.arrayBuffer());
  const filled = await fillPdf(bytes, input.targets, values);
  // What didn't fit was left out on purpose: check everything that went in.
  const left = new Set(filled.omissions.map(({ target }) => target));
  const written = Object.fromEntries(
    Object.entries(values).filter(([target]) => !left.has(target)),
  );
  const problems = await verifyPdf(filled.bytes, input.targets, written);
  const label = (id: string) =>
    input.targets.find((target) => target.id === id)?.label || id;
  const storageId = await ctx.storage.store(
    new Blob([filled.bytes.slice().buffer], { type: "application/pdf" }),
  );
  return {
    storageId,
    omissions: [...filled.omissions, ...problems].map(({ target, reason }) => ({
      label: label(target),
      reason,
    })),
    toComplete,
  };
}

/**
 * Fills the form a case's pack is for, from the case's answers.
 * `fingerprint` is of the answers it read: if they've moved on by the time
 * the document is kept, the case knows the form is behind them.
 */
export const fillForCase = internalAction({
  args: { caseId: v.id("cases") },
  returns: v.union(
    v.object({ ...vFilledDocument.fields, fingerprint: v.string() }),
    v.null(),
  ),
  handler: async (
    ctx,
    { caseId },
  ): Promise<(Filled & { fingerprint: string }) | null> => {
    const editionId: Id<"formEditions"> | null = await ctx.runQuery(
      internal.easygov.forms.data.editionOfCase,
      { caseId },
    );
    if (!editionId) return null;
    const {
      answers,
      fingerprint,
    }: { answers: Record<string, string>; fingerprint?: string } =
      await ctx.runQuery(internal.easygov.forms.data.fillInput, {
        editionId,
        caseId,
      });
    if (fingerprint === undefined) throw new Error("Case not found");
    return { ...(await fill(ctx, editionId, answers, true)), fingerprint };
  },
});

/** Fills an edition with any answers, to look at: reviewed or not. */
export const testFill = action({
  args: {
    editionId: v.id("formEditions"),
    answers: v.record(v.string(), v.string()),
  },
  returns: v.object({
    url: v.union(v.string(), v.null()),
    omissions: v.array(v.object({ label: v.string(), reason: v.string() })),
    toComplete: v.array(vLeft),
  }),
  handler: async (ctx, { editionId, answers }) => {
    await requireOperator(ctx);
    const { storageId, omissions, toComplete } = await fill(
      ctx,
      editionId,
      answers,
      false,
    );
    return { url: await ctx.storage.getUrl(storageId), omissions, toComplete };
  },
});

/** What a filled form holds, read from the PDF itself: for checking it. */
export const readFilled = internalAction({
  args: { storageId: v.id("_storage") },
  returns: v.object({ texts: v.array(v.string()), ticked: v.number() }),
  handler: async (ctx, { storageId }) => {
    const blob = await ctx.storage.get(storageId);
    if (!blob) throw new Error("The filled form is missing");
    const doc = await PDFDocument.load(await blob.arrayBuffer(), {
      ignoreEncryption: true,
      parseSpeed: Infinity,
    });
    const texts: string[] = [];
    let ticked = 0;
    for (const field of doc.getForm().getFields()) {
      if (field instanceof PDFTextField) {
        const text = field.getText();
        if (text) texts.push(text);
      } else if (field instanceof PDFCheckBox && field.isChecked()) {
        ticked++;
      }
    }
    return { texts, ticked };
  },
});

export const fillPacket = internalAction({
  args: { caseId: v.id("cases") },
  returns: v.object({
    fingerprint: v.string(),
    documents: v.array(vPacketPdf),
    openItems: v.array(v.string()),
  }),
  handler: async (
    ctx,
    { caseId },
  ): Promise<{
    fingerprint: string;
    documents: Infer<typeof vPacketPdf>[];
    openItems: string[];
  }> => {
    const { forms, answers, fingerprint } = await ctx.runQuery(
      internal.easygov.case.data.packetInput,
      { caseId },
    );
    const documents = [];
    const openItems = [];
    for (const { blueprintId, code, sourceUrl, openItem } of forms) {
      if (!blueprintId) {
        openItems.push(openItem ?? `Complete ${code} at ${sourceUrl}`);
        continue;
      }
      try {
        const input = await ctx.runQuery(
          internal.easygov.forms.data.blueprintForFill,
          { id: blueprintId },
        );
        documents.push({
          code,
          sourceUrl,
          ...(await writeDocument(ctx, input, answers)),
        });
      } catch (error) {
        console.error("Could not fill packet form", code, error);
        openItems.push(
          `Complete ${code} at ${sourceUrl}. The PDF could not be filled.`,
        );
      }
    }
    return { fingerprint, documents, openItems };
  },
});
