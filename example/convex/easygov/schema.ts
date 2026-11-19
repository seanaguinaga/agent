// The easygov tables, spread into the root schema. What a case holds is in
// `case/schema.ts`; the firms and referrals are in `firms/schema.ts`.
import { defineTable } from "convex/server";
import { v } from "convex/values";
import { caseFields } from "./case/schema";
import evalTables from "./evals/tables";
import firmTables from "./firms/schema";
import { processPacks } from "./packs/schema";

export const vCaseDoc = v.object({
  _id: v.id("cases"),
  _creationTime: v.number(),
  ...caseFields,
});

export default {
  cases: defineTable(caseFields).index("by_userId", ["userId"]),
  processPacks,
  /** The history of a case: what happened, in order. */
  caseEvents: defineTable({
    caseId: v.id("cases"),
    kind: v.string(),
    detail: v.optional(v.string()),
  }).index("by_caseId", ["caseId"]),
  ...firmTables,
  ...evalTables,
};
