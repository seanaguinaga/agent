// What the collect workflow reads.
import { v } from "convex/values";
import { internalQuery } from "../../../_generated/server";
import { missingInputs } from "../../case/answers";
import type { Case } from "../../case/data";
import { vStageResult, type StageResult } from "../../case/schema";

/** The input keys the case's confirmed pack asks for. */
export function requiredInputs(found: Case) {
  return found.processPack?.definition?.inputs;
}

/** Done once every required answer is in; null keeps the workflow waiting. */
export const check = internalQuery({
  args: { caseId: v.id("cases") },
  returns: v.union(vStageResult, v.null()),
  handler: async (ctx, { caseId }): Promise<StageResult | null> => {
    const found = await ctx.db.get("cases", caseId);
    const inputs = found && requiredInputs(found);
    if (!found || !inputs) return { outcome: "stop", reason: "No process" };
    const missing = missingInputs(inputs, found.answers);
    return missing.length === 0 ? { outcome: "done" } : null;
  },
});
