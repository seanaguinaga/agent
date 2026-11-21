// The runner's bookkeeping, with a mock model: trials are planned, run,
// graded and tallied.
import { afterEach, expect, test, vi } from "vitest";
import { api, internal } from "../../_generated/api";
import { initConvexTest } from "../../setup.test";
import { model, read, resetCases } from "../case/cases.testkit";
import { choose, search } from "./cases";

vi.mock("../../modelsForDemo", async () =>
  (await import("../case/cases.testkit")).mockModels(),
);
afterEach(resetCases);
afterEach(() => vi.unstubAllEnvs());

const runner = api.easygov.evals.runner;

/**
 * Moves the clock on by less than a trial's time limit. Timers are advanced
 * while trials are still running, so running them all would expire a trial
 * that is only waiting its turn.
 */
const soon = () => vi.advanceTimersByTime(10_000);

test("a run plans trials per case, grades them, and tallies passes", async () => {
  vi.useFakeTimers();
  const t = initConvexTest();
  // The mock answers every "choose" with 1: right for some cases only.
  const runId = await t.mutation(runner.start, {
    note: "test",
    slices: ["search", "choose"],
    trials: 2,
  });
  await t.finishAllScheduledFunctions(soon);
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

test("a trial that never reports back is ended, and its case canceled", async () => {
  vi.useFakeTimers();
  const t = initConvexTest();
  const caseId = await t.mutation(api.easygov.case.public.createCase, {});
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  // A trial whose action died after starting its case.
  const { runId, trialId } = await t.run(async (ctx) => {
    const runId = await ctx.db.insert("easygovEvalRuns", {
      note: "stuck",
      models: "mock",
      trialsPerCase: 1,
      totalTrials: 1,
      finishedTrials: 0,
      status: "running",
    });
    const trialId = await ctx.db.insert("easygovEvalTrials", {
      runId,
      slice: "outcome",
      caseId: "a referral",
      trial: 1,
      status: "pending",
      realCase: { id: caseId, startedAt: Date.now(), goalSent: true },
    });
    return { runId, trialId };
  });
  const { expireTrial } = internal.easygov.evals.runner;
  await t.mutation(expireTrial, { trialId });
  expect((await t.query(runner.trials, { runId }))[0]).toMatchObject({
    status: "error",
    error: "The trial never finished",
  });
  expect((await t.query(runner.runs, {}))[0]).toMatchObject({
    status: "done",
    finishedTrials: 1,
  });
  expect((await read(t, caseId)).status).toBe("canceled");
  // Once: a trial that has ended isn't counted again.
  await t.mutation(expireTrial, { trialId });
  expect((await t.query(runner.runs, {}))[0].finishedTrials).toBe(1);
});

test("a real draft is saved as a case, and joins the draft slice", async () => {
  vi.useFakeTimers();
  const t = initConvexTest();
  const caseId = await t.mutation(api.easygov.case.public.createCase, {});
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
      goal: { text: "Contest my ticket", version: 1 },
      selection: {
        status: "proposed",
        kind: "draft",
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

/** The scheduled calls of one function that haven't finished. */
async function waiting(t: ReturnType<typeof initConvexTest>, name: string) {
  const jobs = await t.run((ctx) =>
    ctx.db.system.query("_scheduled_functions").collect(),
  );
  return jobs.filter(
    (job) =>
      job.name.includes(name) &&
      (job.state.kind === "pending" || job.state.kind === "inProgress"),
  );
}

test("a serial run starts one trial at a time, in planned order", async () => {
  vi.useFakeTimers();
  const t = initConvexTest();
  const runId = await t.mutation(runner.start, {
    note: "one by one",
    slices: ["choose"],
    trials: 2,
    serial: true,
  });
  const total = choose.length * 2;
  // Nothing runs until the held rows are counted.
  expect(await waiting(t, "runTrial")).toHaveLength(0);
  expect(await waiting(t, "countHeld")).toHaveLength(1);
  const order: string[] = [];
  for (let step = 0; step < total * 4; step++) {
    const [next, ...others] = await waiting(t, "runTrial");
    expect(others).toHaveLength(0);
    if (next) order.push(next.args[0].trialId);
    else if ((await t.query(runner.runs, {}))[0].status === "done") break;
    vi.runAllTimers();
    await t.finishInProgressScheduledFunctions();
  }
  // Each trial was started once, in the order it was planned.
  const planned = await t.run((ctx) =>
    ctx.db
      .query("easygovEvalTrials")
      .withIndex("by_runId", (q) => q.eq("runId", runId))
      .collect(),
  );
  expect([...new Set(order)]).toEqual(planned.map((trial) => trial._id));
  expect((await t.query(runner.runs, {}))[0]).toMatchObject({
    runId,
    serial: true,
    status: "done",
    finishedTrials: total,
    heldAtStart: { addresses: 0 },
  });
});

test("a serial run goes on when a trial expires", async () => {
  vi.useFakeTimers();
  const t = initConvexTest();
  const [first, second] = await t.run(async (ctx) => {
    const runId = await ctx.db.insert("easygovEvalRuns", {
      note: "stuck",
      models: "mock",
      trialsPerCase: 1,
      totalTrials: 2,
      finishedTrials: 0,
      status: "running",
      serial: true,
    });
    const trial = (caseId: string) =>
      ctx.db.insert("easygovEvalTrials", {
        runId,
        slice: "search",
        caseId,
        trial: 1,
        status: "pending",
      });
    return [await trial(search[0].id), await trial(search[1].id)];
  });
  await t.mutation(internal.easygov.evals.runner.expireTrial, {
    trialId: first,
  });
  const [next, ...others] = await waiting(t, "runTrial");
  expect(next.args).toEqual([{ trialId: second }]);
  expect(others).toHaveLength(0);
});

test("a concurrent run starts every trial at once, and isn't serial", async () => {
  vi.useFakeTimers();
  const t = initConvexTest();
  await t.mutation(runner.start, { note: "all", slices: ["search"] });
  expect(await waiting(t, "runTrial")).toHaveLength(search.length);
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect((await t.query(runner.runs, {}))[0]).toMatchObject({
    serial: false,
    status: "done",
  });
});

/** Addresses that answered, and one a form is remembered at. */
async function hold(t: ReturnType<typeof initConvexTest>, addresses: number) {
  await t.run(async (ctx) => {
    const row = (url: string) => ({
      key: url,
      url,
      checkedAt: 0,
      outcome: "gone" as const,
      note: "The source answered 404.",
      failures: 1,
    });
    for (let i = 0; i < addresses; i++) {
      await ctx.db.insert("formAddresses", row(`https://x.gov/${i}.pdf`));
    }
    await ctx.db.insert("formAddresses", {
      ...row("https://www.irs.gov/pub/irs-pdf/f8822.pdf"),
      chosen: { jurisdiction: "us", bare: "8822", code: "IRS-8822", at: 0 },
    });
  });
}

const held = (t: ReturnType<typeof initConvexTest>) =>
  t.run(async (ctx) =>
    (await ctx.db.query("formAddresses").collect()).map((row) => row.url),
  );

test("a run records what was held when it started", async () => {
  vi.useFakeTimers();
  const t = initConvexTest();
  // More than two batches, so the count goes on where it left off.
  await hold(t, 202);
  await t.mutation(runner.start, { note: "warm", slices: ["search"] });
  expect((await t.query(runner.runs, {}))[0].heldAtStart).toBeNull();
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect((await t.query(runner.runs, {}))[0].heldAtStart).toEqual({
    addresses: 203,
  });
});

test("forgetting what was fetched keeps the addresses chosen", async () => {
  vi.useFakeTimers();
  const t = initConvexTest();
  await hold(t, 205);
  await t.mutation(runner.forgetFetched, {});
  // One batch is gone, and the rest follow.
  expect(await held(t)).toHaveLength(186);
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(await held(t)).toEqual(["https://www.irs.gov/pub/irs-pdf/f8822.pdf"]);
  await t.mutation(runner.start, { note: "cold", slices: ["search"] });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect((await t.query(runner.runs, {}))[0].heldAtStart).toEqual({
    addresses: 1,
  });
});

test("only an operator forgets what was fetched", async () => {
  const t = initConvexTest();
  await hold(t, 1);
  vi.stubEnv("EASYGOV_OPERATORS", "someone else");
  await expect(t.mutation(runner.forgetFetched, {})).rejects.toThrow(
    /Operators only/,
  );
  expect(await held(t)).toHaveLength(2);
});
