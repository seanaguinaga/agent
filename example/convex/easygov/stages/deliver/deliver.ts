// The deliver stage: marks the approved artifact as ready to send. Nothing is
// sent yet.
import { v } from "convex/values";
import { z } from "zod/v4";
import { internal } from "../../../_generated/api";
import { internalMutation } from "../../../_generated/server";
import { defineStage } from "../../stage";
import type { StageResult } from "../../validators";

export const deliverParams = z.strictObject({
  channel: z.enum(["mail", "online"]),
});

export const prepare = internalMutation({
  args: { caseId: v.id("cases"), channel: v.string() },
  returns: v.null(),
  handler: async (ctx, { caseId, channel }) => {
    await ctx.db.patch("cases", caseId, {
      delivery: { status: "prepared", channel },
    });
    return null;
  },
});

export const run = defineStage(
  async (step, { caseId, params }): Promise<StageResult> => {
    const { channel } = deliverParams.parse(params ?? {});
    await step.runMutation(internal.easygov.stages.deliver.deliver.prepare, {
      caseId,
      channel,
    });
    return { outcome: "done" };
  },
);
