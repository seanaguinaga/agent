// The fill stage: writes the artifact from the current answers. A stand-in for PDF filling.
import { v } from "convex/values";
import { z } from "zod/v4";
import { internal } from "../../../_generated/api";
import { internalMutation } from "../../../_generated/server";
import { fingerprint } from "../../answers";
import { defineStage } from "../../stage";
import type { StageResult } from "../../validators";

export const fillParams = z.strictObject({});

export const write = internalMutation({
  args: { caseId: v.id("cases") },
  returns: v.null(),
  handler: async (ctx, { caseId }) => {
    const found = await ctx.db.get("cases", caseId);
    if (!found) return null;
    const summary = JSON.stringify({
      process: found.processKey,
      answers: found.answers,
    });
    await ctx.db.patch("cases", caseId, {
      artifact: { summary, fingerprint: fingerprint(found.answers) },
    });
    return null;
  },
});

export const run = defineStage(
  async (step, { caseId }): Promise<StageResult> => {
    await step.runMutation(internal.easygov.stages.fill.fill.write, { caseId });
    return { outcome: "done" };
  },
);
