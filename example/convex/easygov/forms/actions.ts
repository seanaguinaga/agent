"use node";
// The PDF work: fetching a form from its authority, reading it, and filling
// it. In Node because the PDF libraries need it.
import { requireOperator } from "../operators";
import { sha256 } from "@noble/hashes/sha2.js";
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
import { browserService, downloadViaBrowser } from "./browser";
import { resolveMapping } from "./mapping";
import { openForFilling, UnusablePdf } from "./open";
import { fillPdf, inspectPdf, verifyPdf } from "./pdf";
import {
  vFilledDocument,
  vLeft,
  vTarget,
  vMapping,
  vPacketPdf,
} from "./schema";
import { isOfficialHost } from "./data";
import { namesForm, obtain } from "./sources";

const fetchArgs = {
  formId: v.id("forms"),
  /** Read the targets again even if these bytes are known. */
  reinspect: v.optional(v.boolean()),
};
const vFetched = v.object({
  editionId: v.id("formEditions"),
  fresh: v.boolean(),
});
type Fetched = Infer<typeof vFetched>;

/**
 * Fetches a form from its source and records what came back. The same bytes
 * as before only refresh `checkedAt`; different bytes are a new edition,
 * read for its revision and targets. Returns the edition.
 */
async function fetchEdition(
  ctx: ActionCtx,
  { formId, reinspect }: { formId: Id<"forms">; reinspect?: boolean },
): Promise<Fetched> {
  const form: { urls: string[]; code: string } | null = await ctx.runQuery(
    internal.easygov.forms.data.formOf,
    { formId },
  );
  if (!form) throw new ConvexError("Form not found.");
  // A plain request first. Where that's refused, a real browser opens the
  // same address, if one is set up.
  const service = browserService();
  const got = await obtain(form.urls, {
    request: async (url) => {
      let address = url;
      for (let redirects = 0; redirects <= 5; redirects++) {
        if (!isOfficialHost(address))
          throw new Error(
            "The form link left the authority’s permitted sites.",
          );
        const response = await fetch(address, {
          redirect: "manual",
          headers: { "User-Agent": "Mozilla/5.0 (compatible; form-fetch)" },
        });
        if (
          response.status >= 300 &&
          response.status < 400 &&
          response.headers.has("location")
        ) {
          address = new URL(response.headers.get("location")!, address).href;
          continue;
        }
        if (!response.ok)
          throw new Error(`The source answered ${response.status}.`);
        return new Uint8Array(await response.arrayBuffer());
      }
      throw new Error("The form link redirected too many times.");
    },
    browser: service && ((url) => downloadViaBrowser(url, service)),
  });
  const record = (ok: boolean, attempts = got.attempts) =>
    ctx.runMutation(internal.easygov.forms.data.recordAttempts, {
      formId,
      ok,
      attempts,
    });
  if (!("bytes" in got)) {
    await record(false);
    const last = got.attempts.at(-1);
    throw new ConvexError(
      `The form couldn't be fetched. ${last?.note ?? ""}` +
        (service ? "" : " No browser is set up to try next."),
    );
  }
  const { bytes, via, url } = got;
  const hash = bytesToHex(sha256(bytes));
  const known: Id<"formEditions"> | null = await ctx.runMutation(
    internal.easygov.forms.data.recordFetch,
    { formId, sha256: hash },
  );
  if (known && !reinspect) {
    await record(true);
    return { editionId: known, fresh: false };
  }
  // Many forms are protected without a password. Where the file allows
  // its forms to be filled, it's opened; otherwise the fetch stops here,
  // having still found the file.
  const refuse = async (note: string, say: string) => {
    await record(false, [...got.attempts, { via, url, ok: false, note }]);
    return new ConvexError(say);
  };
  let ready: Uint8Array;
  let opened: boolean;
  try {
    ({ bytes: ready, opened } = await openForFilling(bytes));
  } catch (error) {
    const why =
      error instanceof UnusablePdf ? error.message : "It can't be read.";
    throw await refuse(why, `The form was fetched, but can't be used. ${why}`);
  }
  const { pages, edition, fillable, targets, opening } =
    await inspectPdf(ready);
  // Whatever way it came, it has to be the form it's meant to be.
  if (!namesForm(form.code, opening)) {
    throw await refuse(
      `The file doesn't name ${form.code}.`,
      `What came back isn't ${form.code}.`,
    );
  }
  await record(true);
  if (known) {
    await ctx.runMutation(internal.easygov.forms.data.replaceTargets, {
      editionId: known,
      targets,
    });
    return { editionId: known, fresh: false };
  }
  const storageId = await ctx.storage.store(
    // What's kept is the form ready to fill. Its identity is still the
    // hash of the bytes as the authority published them.
    new Blob([ready.slice().buffer], { type: "application/pdf" }),
  );
  const editionId: Id<"formEditions"> | null = await ctx.runMutation(
    internal.easygov.forms.data.recordFetch,
    {
      formId,
      sha256: hash,
      fresh: {
        storageId,
        edition,
        pages,
        fillable,
        targets,
        obtained: { via, url },
        opened,
      },
    },
  );
  if (!editionId) throw new Error("The edition wasn't recorded");
  return { editionId, fresh: true };
}

/** `fetchEdition`, for an operator's page. */
export const fetchForm = action({
  args: fetchArgs,
  returns: vFetched,
  handler: async (ctx, args): Promise<Fetched> => {
    await requireOperator(ctx);
    return await fetchEdition(ctx, args);
  },
});

/** `fetchEdition`, for a case's own work: no operator is signed in there. */
export const fetchSource = internalAction({
  args: fetchArgs,
  returns: vFetched,
  handler: async (ctx, args): Promise<Fetched> => await fetchEdition(ctx, args),
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
