// Where easygov eval results live. Cases live in code (`cases.ts`), except
// the drafts someone saved from a real case to replay.
import { literals } from "convex-helpers/validators";
import { defineTable } from "convex/server";
import { v } from "convex/values";

export const SLICES = [
  "intake",
  "request",
  "choose",
  "research",
  "forms",
  "draft",
  "suggest",
  "tailor",
  "address",
  "mapping",
  "search",
  "outcome",
  "pipeline",
] as const;
export type Slice = (typeof SLICES)[number];
export const vSlice = literals(...SLICES);

/** Which trial of a run this is. */
const trialKey = { slice: vSlice, caseId: v.string(), trial: v.number() };

/** A trial that ran and was graded. */
const graded = {
  status: v.union(v.literal("passed"), v.literal("failed")),
  /**
   * Each thing graded, by name. A name starting with "~" is recorded but
   * doesn't decide the trial: it's too noisy to fail on.
   */
  checks: v.record(v.string(), v.boolean()),
  /** What the step produced, as JSON, to read when a check fails. */
  output: v.string(),
  /** Why: the judge's reasoning, or what a code check tripped on. */
  detail: v.optional(v.string()),
  ms: v.number(),
};

/** A trial that crashed (model or network error): not a pass or a fail. */
const errored = {
  status: v.literal("error"),
  error: v.string(),
  ms: v.number(),
};

/** How a trial ended, by `status`. */
export const vTrialOutcome = v.union(v.object(graded), v.object(errored));

/** A trial as `trials` returns it, by `status`: pending until it ends. */
export const vTrialView = v.union(
  v.object({ ...trialKey, status: v.literal("pending") }),
  v.object({ ...trialKey, ...graded }),
  v.object({ ...trialKey, ...errored }),
);

const trialRow = { runId: v.id("easygovEvalRuns"), ...trialKey };

/** For "outcome" and "pipeline": the real case a pending trial is driving. */
const realCase = v.object({
  id: v.id("cases"),
  startedAt: v.number(),
  goalSent: v.boolean(),
});

/** Whether the judge got a known-good and a known-bad draft right. */
export const vJudgeCheck = v.object({
  goodPassed: v.boolean(),
  badFailed: v.boolean(),
  error: v.optional(v.string()),
});

/** What a draft is written from: the frozen input of a draft eval. */
export const draftInput = {
  process: v.string(),
  jurisdiction: v.string(),
  authority: v.optional(v.string()),
  forms: v.array(v.string()),
  notes: v.string(),
};

export default {
  easygovEvalRuns: defineTable({
    /** What changed since the last run, e.g. "draft: no 'the notes'". */
    note: v.string(),
    models: v.string(),
    trialsPerCase: v.number(),
    totalTrials: v.number(),
    finishedTrials: v.number(),
    status: v.union(v.literal("running"), v.literal("done")),
    judgeCheck: v.optional(vJudgeCheck),
  }),
  easygovEvalTrials: defineTable(
    v.union(
      v.object({
        ...trialRow,
        status: v.literal("pending"),
        realCase: v.optional(realCase),
      }),
      v.object({ ...trialRow, ...graded }),
      v.object({ ...trialRow, ...errored }),
    ),
  ).index("by_runId", ["runId"]),
  /** A real draft's inputs, saved from a case to replay as a draft eval. */
  easygovEvalCases: defineTable({ name: v.string(), ...draftInput }),
};
