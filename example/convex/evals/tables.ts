import { zodOutputToConvex } from "convex-helpers/server/zod3";
import { literals } from "convex-helpers/validators";
import { defineTable } from "convex/server";
import { v } from "convex/values";
import { z } from "zod/v3";
import { outfitSchema } from "../workflows/outfit";

export const verdict = z.enum(["pass", "fail", "unknown"]);
const vVerdict = literals(...verdict.options);

export const vOutfit = zodOutputToConvex(outfitSchema);
export const vGrades = v.object({
  temperature: v.boolean(),
  outfit: v.optional(vVerdict),
});
export const vRunStatus = v.union(v.literal("running"), v.literal("done"));
export const vJudgeCheck = v.object({
  goodPassed: v.boolean(),
  badFailed: v.boolean(),
  error: v.optional(v.string()),
});

export const vTrialResult = v.union(
  v.literal("passed"),
  v.literal("failed"),
  // The trial crashed (model or network error): not counted as a pass or fail.
  v.literal("error"),
);

export default {
  evalRuns: defineTable({
    /** What changed since the last run, e.g. "weather: don't invent on error". */
    note: v.string(),
    commit: v.optional(v.string()),
    /** provider/modelId of the agents' language model. */
    model: v.string(),
    trialsPerCase: v.number(),
    totalTrials: v.number(),
    finishedTrials: v.number(),
    status: vRunStatus,
    /** Whether the judge got the known-good and known-bad outfits right. */
    judgeCheck: v.optional(vJudgeCheck),
  }),

  evalTrials: defineTable({
    runId: v.id("evalRuns"),
    caseId: v.string(),
    trial: v.number(),
    /** The trial's agent thread: read it for the full transcript. */
    threadId: v.optional(v.string()),
    status: v.union(v.literal("pending"), vTrialResult),
    forecast: v.optional(v.string()),
    outfit: v.optional(vOutfit),
    grades: v.optional(vGrades),
    judgeReasoning: v.optional(v.string()),
    error: v.optional(v.string()),
  })
    .index("by_runId", ["runId"])
    .index("by_threadId", ["threadId"]),
};
