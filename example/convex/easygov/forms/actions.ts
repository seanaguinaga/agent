"use node";
// The PDF work: fetching a form from its authority, reading it, and filling
// it. In Node because the PDF libraries need it.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { ConvexError, v } from "convex/values";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import {
  action,
  internalAction,
  type ActionCtx,
} from "../../_generated/server";
import { resolveMapping } from "./mapping";
import { fillPdf, inspectPdf, verifyPdf } from "./pdf";
import { vLeft } from "./schema";

/** Larger than any form we'd fill, small enough to hold in memory. */
const MAX_BYTES = 20 * 1024 * 1024;

/**
 * Fetches a form from its source and records what came back. The same bytes
 * as before only refresh `checkedAt`; different bytes are a new edition,
 * read for its revision and targets. Returns the edition.
 */
export const fetchForm = action({
  args: {
    formId: v.id("forms"),
    /** Read the targets again even if these bytes are known. */
    reinspect: v.optional(v.boolean()),
  },
  returns: v.object({ editionId: v.id("formEditions"), fresh: v.boolean() }),
  handler: async (
    ctx,
    { formId, reinspect },
  ): Promise<{ editionId: Id<"formEditions">; fresh: boolean }> => {
    const form: { sourceUrl: string; code: string } | null = await ctx.runQuery(
      internal.easygov.forms.data.formOf,
      { formId },
    );
    if (!form) throw new ConvexError("Form not found.");
    const response = await fetch(form.sourceUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; form-fetch)" },
    });
    if (!response.ok) {
      throw new ConvexError(`The source answered ${response.status}.`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > MAX_BYTES)
      throw new ConvexError("The file is too large.");
    if (new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") {
      throw new ConvexError("The source didn't return a PDF.");
    }
    const hash = bytesToHex(sha256(bytes));
    const known: Id<"formEditions"> | null = await ctx.runMutation(
      internal.easygov.forms.data.recordFetch,
      { formId, sha256: hash },
    );
    if (known && !reinspect) return { editionId: known, fresh: false };
    const { pages, edition, fillable, targets } = await inspectPdf(bytes);
    if (known) {
      await ctx.runMutation(internal.easygov.forms.data.replaceTargets, {
        editionId: known,
        targets,
      });
      return { editionId: known, fresh: false };
    }
    const storageId = await ctx.storage.store(
      new Blob([bytes.slice().buffer], { type: "application/pdf" }),
    );
    const editionId: Id<"formEditions"> | null = await ctx.runMutation(
      internal.easygov.forms.data.recordFetch,
      {
        formId,
        sha256: hash,
        fresh: { storageId, edition, pages, fillable, targets },
      },
    );
    if (!editionId) throw new Error("The edition wasn't recorded");
    return { editionId, fresh: true };
  },
});

const vFilled = v.object({
  storageId: v.id("_storage"),
  /** Values that weren't written, each with why. Never cut short to fit. */
  omissions: v.array(v.object({ label: v.string(), reason: v.string() })),
  /** What's left for the person, and why. */
  toComplete: v.array(vLeft),
});
type Filled = typeof vFilled.type;

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

/** Fills the form a case's pack is for, from the case's answers. */
export const fillForCase = internalAction({
  args: { caseId: v.id("cases") },
  returns: v.union(vFilled, v.null()),
  handler: async (ctx, { caseId }): Promise<Filled | null> => {
    const editionId: Id<"formEditions"> | null = await ctx.runQuery(
      internal.easygov.forms.data.editionOfCase,
      { caseId },
    );
    if (!editionId) return null;
    const { answers }: { answers: Record<string, string> } = await ctx.runQuery(
      internal.easygov.forms.data.fillInput,
      { editionId, caseId },
    );
    return await fill(ctx, editionId, answers, true);
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
    const { storageId, omissions, toComplete } = await fill(
      ctx,
      editionId,
      answers,
      false,
    );
    return { url: await ctx.storage.getUrl(storageId), omissions, toComplete };
  },
});
