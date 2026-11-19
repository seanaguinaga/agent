// The runner's bookkeeping, with a mock model: trials are planned, run,
// graded and tallied.
import { afterEach, expect, test, vi } from "vitest";
import { api } from "../../_generated/api";
import { initConvexTest } from "../../setup.test";
import { model, resetCases } from "../case/cases.testkit";
import { choose, search } from "./cases";

vi.mock("../../modelsForDemo", async () =>
  (await import("../case/cases.testkit")).mockModels(),
);
afterEach(resetCases);

const runner = api.easygov.evals.runner;

test("a run plans trials per case, grades them, and tallies passes", async () => {
  vi.useFakeTimers();
  const t = initConvexTest();
  // The mock answers every "choose" with 1: right for some cases only.
  const runId = await t.mutation(runner.start, {
    note: "test",
    slices: ["search", "choose"],
    trials: 2,
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const [run] = await t.query(runner.runs, {});
  expect(run).toMatchObject({
    runId,
    status: "done",
    // The search has no model: one trial each. The rest get two.
    totalTrials: search.length + choose.length * 2,
    finishedTrials: search.length + choose.length * 2,
  });
  expect(run.slices.search).toEqual({
    passed: search.length,
    graded: search.length,
    errors: 0,
  });
  const expectOne = choose.filter((c) => c.expect === 1).length;
  expect(run.slices.choose).toEqual({
    passed: expectOne * 2,
    graded: choose.length * 2,
    errors: 0,
  });
  expect(run.cases["choose / the matching pack"]).toBe("2/2");
  const failed = await t.query(runner.trials, { runId, failedOnly: true });
  expect(failed).toHaveLength((choose.length - expectOne) * 2);
  expect(failed[0]).toMatchObject({
    slice: "choose",
    checks: { choice: false },
  });
});

test("a crashed trial is an error, not a failure", async () => {
  vi.useFakeTimers();
  const t = initConvexTest();
  model.failing = true;
  const runId = await t.mutation(runner.start, {
    note: "down",
    slices: ["request"],
    trials: 1,
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const [run] = await t.query(runner.runs, {});
  expect(run.slices.request).toMatchObject({ passed: 0, graded: 0 });
  expect(run.slices.request.errors).toBeGreaterThan(0);
  expect((await t.query(runner.trials, { runId }))[0]).toMatchObject({
    status: "error",
    error: expect.stringMatching(/down/),
  });
});

test("a real draft is saved as a case, and joins the draft slice", async () => {
  vi.useFakeTimers();
  const t = initConvexTest();
  const caseId = await t.mutation(api.easygov.case.public.startCase, {});
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  await expect(t.mutation(runner.saveDraftCase, { caseId })).rejects.toThrow(
    /no draft/,
  );
  const draft = {
    title: "Contest a ticket",
    description: "Contest a parking ticket.",
    aliases: [],
    jurisdiction: "us/ca/alameda",
    forms: [],
    inputs: [],
  };
  await t.run(async (ctx) => {
    await ctx.db.patch("cases", caseId, {
      intake: { goal: "Contest my ticket", version: 1 },
      processPack: {
        status: "proposed",
        goalVersion: 1,
        draft,
        research: "Within 21 days. https://www.oaklandca.gov/tickets",
      },
    });
  });
  await t.mutation(runner.saveDraftCase, { caseId });
  expect(await t.query(runner.savedCases, {})).toMatchObject([
    { name: "Contest a ticket", jurisdiction: "us/ca/alameda", hasNotes: true },
  ]);
});
