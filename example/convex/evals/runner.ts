// Runs the eval cases in ./cases.ts against the real agents and records the
// results, so prompt and code changes can be compared run over run.
//
//   npx convex run evals/runner:start '{"note":"baseline"}'
//   npx convex run evals/runner:compare
//   npx convex run evals/runner:failures '{"runId":"..."}'
//   npx convex run evals/runner:transcript '{"threadId":"..."}'
import {
  createThread,
  listMessages,
  saveMessage,
  vMessageDoc,
} from "@convex-dev/agent";
import { doc } from "convex-helpers/validators";
import { v } from "convex/values";
import { components, internal } from "../_generated/api";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "../_generated/server";
import { languageModel } from "../modelsForDemo";
import schema from "../schema";
import { cases, EVAL_USER_PREFIX, getCase } from "./cases";
import { gradeForecast, judgeCheck, judgeOutfit } from "./grading";
import { vGrades, vJudgeCheck, vOutfit, vRunStatus, vTrialResult } from "./tables";

const DEFAULT_TRIALS = 3;

/** Starts a run: every selected case, `trials` times, each on a fresh thread. */
export const start = internalMutation({
  args: {
    note: v.string(),
    commit: v.optional(v.string()),
    trials: v.optional(v.number()),
    caseIds: v.optional(v.array(v.string())),
  },
  returns: v.id("evalRuns"),
  handler: async (ctx, { note, commit, trials = DEFAULT_TRIALS, caseIds }) => {
    if (!Number.isInteger(trials) || trials < 1 || trials > 10) {
      throw new Error("trials must be a whole number from 1 to 10");
    }
    const selected = caseIds ? caseIds.map(getCase) : cases;
    const runId = await ctx.db.insert("evalRuns", {
      note,
      commit,
      model: `${languageModel.provider}/${languageModel.modelId}`,
      trialsPerCase: trials,
      totalTrials: selected.length * trials,
      finishedTrials: 0,
      status: "running",
    });
    for (const evalCase of selected) {
      for (let trial = 1; trial <= trials; trial++) {
        const trialId = await ctx.db.insert("evalTrials", {
          runId,
          caseId: evalCase.id,
          trial,
          status: "pending",
        });
        await ctx.scheduler.runAfter(0, internal.evals.runner.runTrial, {
          trialId,
        });
      }
    }
    await ctx.scheduler.runAfter(0, internal.evals.runner.checkJudge, {
      runId,
    });
    return runId;
  },
});

/** One trial: the same two steps as `weatherAgentWorkflow`, then grading. */
export const runTrial = internalAction({
  args: { trialId: v.id("evalTrials") },
  returns: v.null(),
  handler: async (ctx, { trialId }): Promise<null> => {
    const { threadId, caseId } = await ctx.runMutation(
      internal.evals.runner.beginTrial,
      { trialId },
    );
    const evalCase = getCase(caseId);
    try {
      const ask = (prompt: string) =>
        saveMessage(ctx, components.agent, { threadId, prompt });

      const weatherQ = await ask(`What is the weather in ${evalCase.location}?`);
      const forecast = await ctx.runAction(
        internal.workflows.chaining.getForecast,
        { threadId, promptMessageId: weatherQ.messageId },
      );
      const fashionQ = await ask("What should I wear based on the weather?");
      const fashion = await ctx.runAction(
        internal.workflows.chaining.getFashionAdvice,
        { threadId, promptMessageId: fashionQ.messageId },
      );

      const temperature = gradeForecast(evalCase, forecast.text);
      const judged = evalCase.weather
        ? await judgeOutfit(evalCase.weather, evalCase.expected, fashion.object)
        : undefined;
      const passed = temperature && (!judged || judged.verdict === "pass");

      await ctx.runMutation(internal.evals.runner.finishTrial, {
        trialId,
        status: passed ? "passed" : "failed",
        forecast: forecast.text,
        outfit: fashion.object,
        grades: { temperature, outfit: judged?.verdict },
        judgeReasoning: judged?.reasoning,
      });
    } catch (error) {
      await ctx.runMutation(internal.evals.runner.finishTrial, {
        trialId,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  },
});

export const beginTrial = internalMutation({
  args: { trialId: v.id("evalTrials") },
  returns: v.object({ threadId: v.string(), caseId: v.string() }),
  handler: async (ctx, { trialId }) => {
    const trial = await ctx.db.get("evalTrials", trialId);
    if (!trial) throw new Error(`Eval trial ${trialId} not found`);
    const threadId = await createThread(ctx, components.agent, {
      // Marks the thread as an eval trial: see EVAL_USER_PREFIX.
      userId: `${EVAL_USER_PREFIX}${trial.runId}`,
      title: `Eval: ${trial.caseId} #${trial.trial}`,
    });
    await ctx.db.patch("evalTrials", trialId, { threadId });
    return { threadId, caseId: trial.caseId };
  },
});

export const finishTrial = internalMutation({
  args: {
    trialId: v.id("evalTrials"),
    status: vTrialResult,
    forecast: v.optional(v.string()),
    outfit: v.optional(vOutfit),
    grades: v.optional(vGrades),
    judgeReasoning: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { trialId, ...result }) => {
    const trial = await ctx.db.get("evalTrials", trialId);
    if (!trial || trial.status !== "pending") return null;
    await ctx.db.patch("evalTrials", trialId, result);
    const run = await ctx.db.get("evalRuns", trial.runId);
    if (!run) return null;
    const finishedTrials = run.finishedTrials + 1;
    await ctx.db.patch("evalRuns", run._id, {
      finishedTrials,
      status: finishedTrials >= run.totalTrials ? "done" : "running",
    });
    return null;
  },
});

/** Grades a known-good and a known-bad outfit to check the judge itself. */
export const checkJudge = internalAction({
  args: { runId: v.id("evalRuns") },
  returns: v.null(),
  handler: async (ctx, { runId }): Promise<null> => {
    const { weather, expected, good, bad } = judgeCheck;
    let result;
    try {
      const [goodVerdict, badVerdict] = await Promise.all([
        judgeOutfit(weather, expected, good),
        judgeOutfit(weather, expected, bad),
      ]);
      result = {
        goodPassed: goodVerdict.verdict === "pass",
        badFailed: badVerdict.verdict === "fail",
      };
    } catch (error) {
      result = {
        goodPassed: false,
        badFailed: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    await ctx.runMutation(internal.evals.runner.recordJudgeCheck, {
      runId,
      judgeCheck: result,
    });
    return null;
  },
});

export const recordJudgeCheck = internalMutation({
  args: {
    runId: v.id("evalRuns"),
    judgeCheck: vJudgeCheck,
  },
  returns: v.null(),
  handler: async (ctx, { runId, judgeCheck }) => {
    await ctx.db.patch("evalRuns", runId, { judgeCheck });
    return null;
  },
});

/** Used by the weather tools to find an eval thread's case. */
export const caseForThread = internalQuery({
  args: { threadId: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { threadId }) => {
    const trial = await ctx.db
      .query("evalTrials")
      .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
      .unique();
    return trial?.caseId ?? null;
  },
});

/**
 * Recent runs, oldest first, with each case's pass count, e.g. "2/3".
 * Trials that crashed count under `errors`, not as failures.
 */
export const compare = internalQuery({
  args: { limit: v.optional(v.number()) },
  returns: v.array(
    v.object({
      runId: v.id("evalRuns"),
      note: v.string(),
      commit: v.optional(v.string()),
      model: v.string(),
      status: vRunStatus,
      judgeOk: v.union(v.boolean(), v.null()),
      cases: v.record(v.string(), v.string()),
      errors: v.number(),
      totalTokens: v.number(),
    }),
  ),
  handler: async (ctx, { limit = 10 }) => {
    const runs = await ctx.db.query("evalRuns").order("desc").take(limit);
    const rows = [];
    for (const run of runs) {
      const trials = await ctx.db
        .query("evalTrials")
        .withIndex("by_runId", (q) => q.eq("runId", run._id))
        .collect();
      const counts: Record<string, { passed: number; graded: number }> = {};
      let errors = 0;
      for (const trial of trials) {
        const count = (counts[trial.caseId] ??= { passed: 0, graded: 0 });
        if (trial.status === "passed") count.passed++;
        if (trial.status === "passed" || trial.status === "failed") {
          count.graded++;
        }
        if (trial.status === "error") errors++;
      }
      const usage = await ctx.db
        .query("rawUsage")
        .withIndex("by_userId", (q) =>
          q.eq("userId", `${EVAL_USER_PREFIX}${run._id}`),
        )
        .collect();
      rows.push({
        runId: run._id,
        note: run.note,
        commit: run.commit,
        model: run.model,
        status: run.status,
        judgeOk: run.judgeCheck
          ? run.judgeCheck.goodPassed && run.judgeCheck.badFailed
          : null,
        cases: Object.fromEntries(
          Object.entries(counts).map(([caseId, c]) => [
            caseId,
            `${c.passed}/${c.graded}`,
          ]),
        ),
        errors,
        totalTokens: usage.reduce(
          (sum, u) => sum + (u.usage.totalTokens ?? 0),
          0,
        ),
      });
    }
    return rows.reverse();
  },
});

/** A run's failed and crashed trials, with what to read for each. */
export const failures = internalQuery({
  args: { runId: v.id("evalRuns") },
  returns: v.array(doc(schema, "evalTrials")),
  handler: async (ctx, { runId }) => {
    const trials = await ctx.db
      .query("evalTrials")
      .withIndex("by_runId", (q) => q.eq("runId", runId))
      .collect();
    return trials.filter((t) => t.status === "failed" || t.status === "error");
  },
});

/** A trial's full transcript, oldest first, including tool calls and results. */
export const transcript = internalQuery({
  args: { threadId: v.string() },
  returns: v.array(vMessageDoc),
  handler: async (ctx, { threadId }) => {
    const { page } = await listMessages(ctx, components.agent, {
      threadId,
      paginationOpts: { cursor: null, numItems: 100 },
      excludeToolMessages: false,
    });
    return page.reverse();
  },
});
