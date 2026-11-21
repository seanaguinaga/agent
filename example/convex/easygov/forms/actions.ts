"use node";
// The PDF work: fetching a form from its authority, reading it, and filling
// it. In Node because the PDF libraries need it.
import { requireOperator } from "../operators";
import { sha256 as sha256Of } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { ConvexError, v, type Infer } from "convex/values";
import { PDFCheckBox, PDFDocument, PDFTextField } from "pdf-lib";
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
  downloadViaBrowser,
  readViaBrowser,
} from "./browser";
import { resolveMapping } from "./mapping";
import { openForFilling, UnusablePdf } from "./open";
import { fillPdf, inspectPdf, verifyPdf } from "./pdf";
import { languageOf, revisionOf, type FormFacts } from "./facts";
import {
  vAddressOutcome,
  vFilledDocument,
  vFormFacts,
  vPageLink,
  vLeft,
  vTarget,
  vMapping,
  vPacketPdf,
} from "./schema";
import { isOfficialHost } from "./data";
import {
  addressKey,
  isTheForm,
  isWebPage,
  labelledLinks,
  notAPdf,
  stands,
  type PageLink,
} from "./sources";

// --- Asking an official address ---------------------------------------------
//
// Every fetch goes through `ask`: a case finding its forms, a case reading a
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
});
type AskCost = Infer<typeof vCost>;

/**
 * Why an ask got nothing. "refused": a plain request was turned away, and a
 * browser may do better. "busy": no browser could be had. "unspent": it
 * would have cost something, and the caller said not to spend.
 */
const vWhyNot = v.union(
  vAddressOutcome,
  v.literal("refused"),
  v.literal("busy"),
  v.literal("otherForm"),
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
};
type Ask = {
  url: string;
  way: "request" | "browser";
  spend: boolean;
  /** The form the address is wanted as. Without one, it is wanted as a page. */
  form?: {
    code: string;
    jurisdiction: string;
    /** The page's words for its link here, if it links it as the form. */
    linkedAs?: string;
    /** The registry entry a new file belongs to. */
    formId?: Id<"forms">;
  };
  /** The caller's packet: what it has asked already isn't asked again. */
  packet?: string;
  /** True to ask even where a failure still stands. */
  again?: boolean;
};
type Asked =
  | {
      ok: true;
      file: { editionId: Id<"formEditions">; facts: FormFacts };
      cost: AskCost;
    }
  | { ok: true; links: PageLink[]; cost: AskCost }
  | Infer<typeof vNo>;

/** One plain request, following redirects on official sites only. */
async function request(
  url: string,
  ms: number,
  held?: { etag?: string; lastModified?: string },
): Promise<
  | {
      got: "body";
      bytes: Uint8Array;
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
      if (!isOfficialHost(address)) {
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
        address = new URL(response.headers.get("location")!, address).href;
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
        bytes: new Uint8Array(await response.arrayBuffer()),
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

/** The links worth keeping from a page: official ones, PDFs first. */
function linksWorthKeeping(html: string, page: string) {
  const links = labelledLinks(html.slice(0, 2_000_000), page).filter(
    ({ url }) => isOfficialHost(url),
  );
  return [
    ...links.filter(({ pdf }) => pdf).slice(0, 300),
    ...links.filter(({ pdf }) => !pdf).slice(0, 300),
  ];
}

/**
 * What an official address serves: a form's file, or a page's links. What
 * it answered before is used first (see `stands`); a file is asked for
 * again only so the server can say it hasn't changed. New bytes are known by
 * their hash, so a file held from another address isn't read or kept twice.
 */
async function ask(
  ctx: ActionCtx,
  { url, way, spend, form, packet, again }: Ask,
): Promise<Asked> {
  const cost = {
    downloads: 0,
    browser: 0,
    pages: 0,
    bytes: 0,
    held: 0,
    reused: 0,
    unchanged: 0,
  };
  const no = (why: Infer<typeof vWhyNot>, note: string) =>
    ({ ok: false, why, note, cost }) as const;
  if (!isOfficialHost(url))
    return no("unusable", "Not the authority’s own site.");
  const key = addressKey(url);
  const held = await ctx.runQuery(internal.easygov.forms.data.addressOf, {
    key,
  });
  if (held) cost.held++;
  const keep = (
    answer: Omit<
      typeof internal.easygov.forms.data.recordAddress._args,
      "key" | "url" | "packet"
    >,
  ) =>
    ctx.runMutation(internal.easygov.forms.data.recordAddress, {
      key,
      url,
      packet,
      ...answer,
    });
  /** A file as the form it is wanted as. Undefined: it has yet to be kept. */
  const asFile = (file: {
    opening?: string;
    facts?: FormFacts;
    editionId?: Id<"formEditions">;
  }): Asked | undefined => {
    if (!form) return no("unusable", "It isn't a web page.");
    if (!isTheForm(form.code, file.opening ?? "", form.linkedAs)) {
      return no("otherForm", `The file doesn't name ${form.code}.`);
    }
    const { editionId, facts } = file;
    return editionId && facts
      ? { ok: true, file: { editionId, facts }, cost }
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
          ? asPage(held.links ?? [])
          : no(held.outcome, held.note ?? "");
    if (answer) {
      cost.reused++;
      return answer;
    }
  }
  if (!spend) return no("unspent", "");

  let bytes: Uint8Array;
  let html = !form;
  let etag: string | undefined;
  let lastModified: string | undefined;
  if (way === "request") {
    cost[form ? "downloads" : "pages"]++;
    // Only a file that is still kept can be told "the same as before".
    const kept = held?.outcome === "file" && held.editionId ? held : undefined;
    const got = await request(url, form ? 45_000 : 15_000, form && kept);
    if (got.got === "unchanged" && kept) {
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
    if (got.got === "gone" || got.got === "unusable") {
      await keep({ outcome: got.got, note: got.note });
      return no(got.got, got.note);
    }
    if (got.got !== "body") return no("refused", got.note);
    ({ bytes, html, etag, lastModified } = got);
  } else {
    const service = browserService();
    if (!service) return no("busy", "No browser is set up.");
    const leaseId = await browserLease(ctx);
    if (!leaseId) return no("busy", "Every browser is in use.");
    try {
      cost.browser++;
      bytes = form
        ? await downloadViaBrowser(url, service)
        : new TextEncoder().encode(await readViaBrowser(url, service));
    } catch (error) {
      if (error instanceof BrowserBusy) return no("busy", error.message);
      const note = `${error instanceof Error ? error.message : error}`;
      await keep({ outcome: "unreachable", note: note.slice(0, 200) });
      return no("unreachable", note);
    } finally {
      await ctx
        .runMutation(internal.easygov.forms.data.releaseBrowserLease, {
          leaseId,
        })
        .catch(() => undefined);
    }
  }

  const problem = notAPdf(bytes);
  if (problem) {
    if (!html && !isWebPage(bytes)) {
      await keep({ outcome: "unusable", note: problem });
      return no("unusable", problem);
    }
    // A page is read for its links, not downloaded from.
    const links = linksWorthKeeping(new TextDecoder().decode(bytes), url);
    await keep({ outcome: "page", links });
    return asPage(links);
  }
  if (!form) return no("unusable", "It isn't a web page.");
  cost.bytes += bytes.length;

  const sha256 = bytesToHex(sha256Of(bytes));
  const served = { outcome: "file" as const, sha256, etag, lastModified };
  const known = await ctx.runMutation(internal.easygov.forms.data.keepFile, {
    sha256,
  });
  if (known.opening !== undefined && known.facts) {
    // The same bytes as before: nothing to read again.
    const answer = asFile(known);
    if (answer) {
      const { opening, facts, editionId } = known;
      await keep({ ...served, opening, facts, editionId });
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
  const { pages, edition, fillable, targets, opening } =
    await inspectPdf(ready);
  const facts: FormFacts = {
    pages,
    places: targets.length,
    language: languageOf(opening),
    revision: revisionOf(`${edition ?? ""} ${opening}`),
  };
  // Whatever way it came, it has to be the form it's meant to be. A file
  // that isn't is still known for what it is, and isn't kept.
  let { editionId } = known;
  if (isTheForm(form.code, opening, form.linkedAs) && !editionId) {
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
  await keep({ ...served, opening, facts, editionId });
  return asFile({ opening, facts, editionId })!;
}

const vFileAnswer = v.union(
  v.object({
    ok: v.literal(true),
    editionId: v.id("formEditions"),
    facts: vFormFacts,
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
    packet: v.optional(v.string()),
  },
  returns: vFileAnswer,
  handler: async (
    ctx,
    { url, way, spend, packet, ...form },
  ): Promise<FileAnswer> => {
    const answer = await ask(ctx, { url, way, spend, packet, form });
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
