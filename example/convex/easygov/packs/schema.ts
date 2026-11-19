import { defineTable } from "convex/server";
import { v } from "convex/values";
import { vPlanStep } from "../plans/schema";

export const vProcessPackQuestions = v.array(
  v.object({ key: v.string(), question: v.string() }),
);
const vProcessPackOutput = v.object({
  title: v.string(),
  checklist: v.array(v.string()),
});

/**
 * What a pack is. There is no key: a pack is its row. Every label here comes
 * from a person or a model and varies ("courts" vs "state-court"), so labels
 * only feed search, and a model compares the candidates.
 */
export const packDefinition = {
  title: v.string(),
  description: v.string(),
  aliases: v.array(v.string()),
  /** Where it applies, as a path: "us", "us/ca", "us/ca/alameda". */
  jurisdiction: v.string(),
  /** Who handles it, as people name it. Searched, never filtered on. */
  authority: v.optional(v.string()),
  /** Official form numbers, e.g. "IRS-8822". Searched, never filtered on. */
  forms: v.array(v.string()),
  inputs: v.array(v.string()),
  plan: v.array(vPlanStep),
  inputQuestions: v.optional(vProcessPackQuestions),
  output: v.optional(vProcessPackOutput),
};
export const vProcessPackDefinition = v.object(packDefinition);

export const processPacks = defineTable({
  ...packDefinition,
  /** Absent for a shared pack, which every case can find. */
  ownerId: v.optional(v.string()),
  /** Only current packs are found. Cases keep the version they pinned. */
  status: v.union(v.literal("current"), v.literal("superseded")),
  /** The version this one replaced. */
  supersedes: v.optional(v.id("processPacks")),
  /** Derived from the definition because each search index takes one text field. */
  searchText: v.string(),
}).searchIndex("search_packs", {
  searchField: "searchText",
  filterFields: ["ownerId", "jurisdiction", "status"],
});

export const vPackMatch = v.object({
  id: v.id("processPacks"),
  title: v.string(),
  description: v.string(),
  jurisdiction: v.string(),
  authority: v.optional(v.string()),
  forms: v.array(v.string()),
});

const MAX_JURISDICTION_DEPTH = 4;
const SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Normalizes a jurisdiction path: an ISO 3166-1 country code, then narrower
 * places ("us/ca/alameda"). Returns null if it isn't one.
 */
export function parseJurisdiction(raw: string): string | null {
  const segments = raw.trim().toLowerCase().split("/");
  if (
    segments.length > MAX_JURISDICTION_DEPTH ||
    !/^[a-z]{2}$/.test(segments[0]) ||
    !segments.every((segment) => segment.length <= 40 && SEGMENT.test(segment))
  ) {
    return null;
  }
  return segments.join("/");
}

/** The jurisdiction and every one containing it, narrowest first. */
export function jurisdictionChain(jurisdiction: string): string[] {
  const segments = jurisdiction.split("/");
  return segments.map((_, i) =>
    segments.slice(0, segments.length - i).join("/"),
  );
}

/** "irs 8822", "IRS-8822" and "Form IRS 8822" are the same form. */
export function normalizeFormId(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/^FORM\b/, "")
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
