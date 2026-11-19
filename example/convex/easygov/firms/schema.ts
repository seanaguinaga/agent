// The law firms, the cases shared with them, and what a firm owes for one it
// accepts.
import { defineTable } from "convex/server";
import { v, type Infer } from "convex/values";
import { jurisdictionChain } from "../packs/schema";

/** What a firm pays for a referral whose pack doesn't set a price. */
export const DEFAULT_PRICE_CENTS = 5000;

/** A kind of referral a firm takes, and where: "us/ca" covers its counties. */
export const vCoverage = v.object({
  kind: v.string(),
  jurisdiction: v.string(),
});
export type Coverage = Infer<typeof vCoverage>;

export const firmFields = {
  name: v.string(),
  /** The account that acts for the firm. */
  userId: v.string(),
  coverage: v.array(vCoverage),
};

/**
 * A file as it's shared: the case's own, and what reading it found.
 * Follow-ups aren't shared: they came after the person said yes.
 */
export const vSharedFile = v.object({
  storageId: v.id("_storage"),
  /** The pack's document this is; without one, other evidence. */
  key: v.optional(v.string()),
  name: v.string(),
  mediaType: v.string(),
  size: v.number(),
  summary: v.optional(v.string()),
});

/**
 * A case the person agreed to share with a lawyer: a copy of what they
 * approved, as it was when they said yes. It never changes after that,
 * except for who took it.
 */
const referralShared = {
  caseId: v.id("cases"),
  userId: v.string(),
  kind: v.string(),
  /** Where it applies. Without one, no firm's coverage matches it. */
  jurisdiction: v.optional(v.string()),
  /** What the accepting firm owes: fixed when shared, whatever comes of it. */
  priceCents: v.number(),
  source: v.optional(v.string()),
  goal: v.string(),
  packId: v.optional(v.id("processPacks")),
  answers: v.record(v.string(), v.string()),
  files: v.array(vSharedFile),
  /** The date to act by, if the pack has one: YYYY-MM-DD. */
  deadline: v.optional(v.string()),
  /** The answers and files the person saw when they agreed. */
  fingerprint: v.string(),
};

/**
 * A referral, by `status`: `open` until one firm accepts it or the person
 * withdraws it. Only an accepted one has a firm, and only that firm ever
 * sees the answers and files.
 */
export const vReferral = v.union(
  v.object({ ...referralShared, status: v.literal("open") }),
  v.object({
    ...referralShared,
    status: v.literal("accepted"),
    /** The firm that accepted it. */
    firmId: v.id("firms"),
  }),
  v.object({ ...referralShared, status: v.literal("withdrawn") }),
);
export type Referral = Infer<typeof vReferral>;

export default {
  firms: defineTable(firmFields).index("by_userId", ["userId"]),
  referrals: defineTable(vReferral)
    .index("by_caseId_and_kind", ["caseId", "kind"])
    .index("by_status_and_kind_and_jurisdiction", [
      "status",
      "kind",
      "jurisdiction",
    ])
    .index("by_firmId", ["firmId"]),
  /** A referral a firm passed on, so it isn't shown to that firm again. */
  referralDeclines: defineTable({
    firmId: v.id("firms"),
    referralId: v.id("referrals"),
  }).index("by_firmId_and_referralId", ["firmId", "referralId"]),
  /** What a firm owes for a referral it accepted. No payment is taken here. */
  referralCharges: defineTable({
    firmId: v.id("firms"),
    referralId: v.id("referrals"),
    amountCents: v.number(),
    status: v.literal("owed"),
  }).index("by_firmId", ["firmId"]),
};

/** Whether a firm takes this kind of referral in this place. */
export function covers(
  coverage: Coverage[],
  referral: { kind: string; jurisdiction?: string },
): boolean {
  const { kind, jurisdiction } = referral;
  if (!jurisdiction) return false;
  const places = jurisdictionChain(jurisdiction);
  return coverage.some(
    (entry) => entry.kind === kind && places.includes(entry.jurisdiction),
  );
}
