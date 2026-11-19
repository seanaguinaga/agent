import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { read, resetCases, send, start, type T } from "../case/cases.testkit";
import { decide, type Input } from "./decide";
import { bootstrapPlan, MAX_VISITS } from "./steps";
import type { Case } from "../case/data";
import { stageEvent, workflow } from "../stages/shared";
import type { StageResult } from "../case/schema";
import type { PlanStep } from "./schema";

vi.mock("../../modelsForDemo", async () =>
  (await import("../case/cases.testkit")).mockModels(),
);

// --- decide: pure, so plain values are enough -------------------------------

describe("decide", () => {
  const referral: PlanStep = {
    id: "referral",
    type: "legalReferral",
    params: { kind: "advice" },
  };

  /** A case at intake's first visit, unless told otherwise. */
  const at = (overrides: Partial<Case> = {}) =>
    ({
      status: "active",
      seq: 1,
      plan: bootstrapPlan,
      currentStep: "intake",
      visits: { intake: 1 },
      answers: {},
      flags: [],
      ...overrides,
    }) as Case;
  const failed = (overrides: Partial<Case> = {}) =>
    at({ failure: { stepId: "intake", error: "boom" }, ...overrides });
  /** The first visit of a step (intake, unless named) returning `result`. */
  const returned = (result: StageResult, stepId = "intake"): Input => ({
    type: "stageDone",
    stepId,
    visit: 1,
    result,
  });

  test("start: runs the first step of the bootstrap plan", () => {
    const fresh = at({ plan: [], currentStep: undefined, visits: {} });
    expect(decide(fresh, { type: "start" })).toEqual({
      type: "run",
      step: bootstrapPlan[0],
      plan: bootstrapPlan,
      notes: [],
    });
  });

  describe("stageDone", () => {
    test("done: runs the next step", () => {
      expect(decide(at(), returned({ outcome: "done" }))).toMatchObject({
        type: "run",
        step: { id: "selectProcessPack" },
        plan: bootstrapPlan,
        notes: ['"intake" returned done'],
      });
    });

    test("done: skips a step whose `when` doesn't pass", () => {
      const when = { input: "wantsRepresentation", equals: "yes" };
      const plan = [bootstrapPlan[0], { ...referral, when }, bootstrapPlan[1]];
      const done = returned({ outcome: "done" });
      expect(decide(at({ plan }), done)).toMatchObject({
        step: { id: "selectProcessPack" },
      });
      const answers = { wantsRepresentation: "yes" };
      expect(decide(at({ plan, answers }), done)).toMatchObject({
        step: { id: "referral" },
      });
    });

    test("done at the end of the plan: the case is done", () => {
      const c = at({
        currentStep: "selectProcessPack",
        visits: { selectProcessPack: 1 },
      });
      expect(
        decide(c, returned({ outcome: "done" }, "selectProcessPack")),
      ).toMatchObject({
        type: "end",
        status: "done",
      });
    });

    test("append: the steps join the plan after the stage's own", () => {
      const result: StageResult = { outcome: "done", append: [referral] };
      const decision = decide(at(), returned(result));
      expect(decision).toMatchObject({
        type: "run",
        step: referral,
        notes: ['"intake" returned done', '"intake" appended referral'],
      });
      expect("plan" in decision && decision.plan.map((s) => s.id)).toEqual([
        "intake",
        "referral",
        "selectProcessPack",
      ]);
    });

    test("a refused append is noted, and the case carries on", () => {
      const append = [{ id: "pay", type: "payFee" }];
      const decision = decide(at(), returned({ outcome: "done", append }));
      expect(decision).toMatchObject({
        type: "run",
        step: { id: "selectProcessPack" },
        plan: bootstrapPlan,
      });
      expect("notes" in decision && decision.notes).toContain(
        '"intake" append refused: Unknown stage type "payFee"',
      );
    });

    test("a refused append with nothing left to run stops the case", () => {
      // Selection finishing with a pack plan that can't be added (its id clashes).
      const c = at({
        currentStep: "selectProcessPack",
        visits: { selectProcessPack: 1 },
      });
      const append = [{ id: "intake", type: "intake" }];
      const decision = decide(
        c,
        returned({ outcome: "done", append }, "selectProcessPack"),
      );
      expect(decision).toMatchObject({ type: "end", status: "stopped" });
      expect("reason" in decision && decision.reason).toMatch(/Steps refused/);
    });

    test("stop: ends the case as stopped, with the stage's reason", () => {
      const result: StageResult = { outcome: "stop", reason: "Not eligible" };
      expect(decide(at(), returned(result))).toMatchObject({
        type: "end",
        status: "stopped",
        reason: "Not eligible",
      });
    });

    test("back: runs the `backTo` step; a missing one is a bug, and throws", () => {
      const c = at({
        currentStep: "selectProcessPack",
        visits: { intake: 1, selectProcessPack: 1 },
      });
      const back = (backTo: string) =>
        returned({ outcome: "back", backTo }, "selectProcessPack");
      expect(decide(c, back("intake"))).toMatchObject({
        type: "run",
        step: { id: "intake" },
      });
      expect(() => decide(c, back("nope"))).toThrow(/missing "nope"/);
    });

    test("a step that has run MAX_VISITS times stops the case", () => {
      const c = at({ visits: { intake: 1, selectProcessPack: MAX_VISITS } });
      const decision = decide(c, returned({ outcome: "done" }));
      expect(decision).toMatchObject({ type: "end", status: "stopped" });
      expect("reason" in decision && decision.reason).toMatch(
        /"selectProcessPack" ran/,
      );
    });
  });

  test("stageFailed: parks the case with the error", () => {
    const input: Input = {
      type: "stageFailed",
      stepId: "intake",
      visit: 1,
      error: "boom",
    };
    expect(decide(at(), input)).toEqual({
      type: "park",
      stepId: "intake",
      error: "boom",
    });
  });

  test.each([
    ["another step", at({ currentStep: "selectProcessPack" })],
    ["an earlier visit", at({ visits: { intake: 2 } })],
    ["a case that has ended", at({ status: "canceled" })],
  ])("a callback from %s is stale, and ignored", (_, c) => {
    const from = { stepId: "intake", visit: 1 };
    const done: Input = {
      type: "stageDone",
      ...from,
      result: { outcome: "done" },
    };
    expect(decide(c, done).type).toBe("ignore");
    const boom: Input = { type: "stageFailed", ...from, error: "boom" };
    expect(decide(c, boom).type).toBe("ignore");
  });

  test("retry: runs the failed step again, only if one failed", () => {
    expect(decide(failed(), { type: "retry" })).toMatchObject({
      type: "run",
      step: { id: "intake" },
      plan: bootstrapPlan,
    });
    expect(decide(at(), { type: "retry" })).toEqual({
      type: "ignore",
      why: "No failed step to recover.",
    });
    // Retries count as visits, so they can't go on for ever.
    const worn = failed({ visits: { intake: MAX_VISITS } });
    expect(decide(worn, { type: "retry" })).toMatchObject({
      type: "end",
      status: "stopped",
    });
  });

  test("giveUp: stops the case, only if a step failed", () => {
    expect(decide(failed(), { type: "giveUp" })).toMatchObject({
      type: "end",
      status: "stopped",
      reason: 'Canceled after "intake" failed',
    });
    expect(decide(at(), { type: "giveUp" }).type).toBe("ignore");
  });

  test("cancel: ends the case as canceled, failed step or not", () => {
    const canceled = {
      type: "end",
      status: "canceled",
      reason: "Canceled by the user",
    };
    expect(decide(at(), { type: "cancel" })).toMatchObject(canceled);
    expect(decide(failed(), { type: "cancel" })).toMatchObject(canceled);
    expect(decide(at({ status: "done" }), { type: "cancel" }).type).toBe(
      "ignore",
    );
  });
});

// --- The whole pipeline, with workflows -------------------------------------

describe("the pipeline", () => {
  afterEach(resetCases);

  /** Makes process pack selection fail when it starts, by breaking its params. */
  async function failProcessPackSelection(t: T, caseId: Id<"cases">) {
    await t.run(async (ctx) => {
      const { plan } = (await ctx.db.get("cases", caseId))!;
      await ctx.db.patch("cases", caseId, {
        plan: plan.map((s) =>
          s.id === "selectProcessPack" ? { ...s, params: {} } : s,
        ),
      });
    });
    return await send(t, caseId, { type: "intake.submit", goal: "I moved" });
  }

  /** Reports `result` as if the intake step's first run had returned it. */
  async function intakeReturns(
    t: T,
    caseId: Id<"cases">,
    result: StageResult,
    from = { stepId: "intake", visit: 1 },
  ) {
    const { workflowId } = await read(t, caseId);
    await t.mutation(internal.easygov.plans.data.stageDone, {
      workflowId: workflowId!,
      result: { kind: "success", returnValue: result },
      context: { caseId, ...from },
    });
    return await read(t, caseId);
  }

  const log = (t: T) =>
    t.run(async (ctx) =>
      (await ctx.db.query("caseEvents").collect()).map((e) =>
        `${e.kind} ${e.detail ?? ""}`.trim(),
      ),
    );

  test("the case names the running stage's workflow, to nudge", async () => {
    const { t, caseId } = await start();
    // Intake is waiting, and the case holds its workflow.
    const { workflowId: intake } = await read(t, caseId);
    const status = await t.run((ctx) => workflow.status(ctx, intake!));
    expect(status.type).toBe("inProgress");

    // A fact written without a nudge isn't noticed; the nudge wakes the stage.
    await t.run((ctx) =>
      ctx.db.patch("cases", caseId, {
        intake: { goal: "I moved", version: 1 },
      }),
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await read(t, caseId)).currentStep).toBe("intake");
    await t.run((ctx) =>
      workflow.sendEvent(ctx, {
        ...stageEvent,
        workflowId: intake!,
        value: null,
      }),
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    // Intake returned, so the case now runs a different workflow: selectProcessPack.
    const found = await read(t, caseId);
    expect(found.currentStep).toBe("selectProcessPack");
    expect(found.workflowId).toBeDefined();
    expect(found.workflowId).not.toBe(intake);
    expect(await log(t)).toEqual([
      "step.started intake #1",
      'note "intake" returned done',
      "step.started selectProcessPack #1",
    ]);
  });

  test("a failed stage has no running workflow, and takes no stage events", async () => {
    const { t, caseId } = await start();
    const found = await failProcessPackSelection(t, caseId);
    expect(found.failure?.stepId).toBe("selectProcessPack");
    // The case waits for a person, not on a workflow.
    expect(found.workflowId).toBeUndefined();
  });

  test("a failed stage waits for a retry, which runs it again", async () => {
    const { t, caseId } = await start();
    let found = await failProcessPackSelection(t, caseId);
    expect(found.status).toBe("active");
    expect(found).toMatchObject({
      currentStep: "selectProcessPack",
      visits: { selectProcessPack: 1 },
      failure: { stepId: "selectProcessPack" },
    });
    expect(found.failure?.error).toBeTruthy();
    // Nothing but a retry or a cancel is taken while the step has failed.
    await expect(
      t.mutation(api.easygov.case.public.send, {
        caseId,
        event: { type: "processPack.reject" },
        expectedSeq: found.seq,
      }),
    ).rejects.toThrow(/isn't expected/);

    // Fix the plan, then retry. The retry clears the failure, so a second
    // click finds nothing to retry.
    await t.run((ctx) =>
      ctx.db.patch("cases", caseId, { plan: bootstrapPlan }),
    );
    await t.mutation(api.easygov.case.public.send, {
      caseId,
      event: { type: "step.retry" },
      expectedSeq: found.seq,
    });
    await expect(
      t.mutation(api.easygov.case.public.send, {
        caseId,
        event: { type: "step.retry" },
        expectedSeq: found.seq + 1,
      }),
    ).rejects.toThrow(/No failed step/);
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    found = await read(t, caseId);
    expect(found).toMatchObject({
      currentStep: "selectProcessPack",
      visits: { selectProcessPack: 2 },
    });
    expect(found.failure).toBeUndefined();
    expect(found.workflowId).toBeDefined();
  });

  test("canceling a failed stage stops the case, which is not success", async () => {
    const { t, caseId } = await start();
    await failProcessPackSelection(t, caseId);
    const found = await send(t, caseId, { type: "step.cancel" });
    expect(found.status).toBe("stopped");
    expect(found.endReason).toMatch(/selectProcessPack/);
  });

  describe("when a stage returns", () => {
    test("appends valid steps after the current one and logs it", async () => {
      const { t, caseId } = await start();
      const extra: PlanStep = {
        id: "referral",
        type: "legalReferral",
        params: { kind: "advice" },
      };
      const found = await intakeReturns(t, caseId, {
        outcome: "done",
        append: [extra],
      });
      expect(found.plan.map((s) => s.id)).toEqual([
        "intake",
        "referral",
        "selectProcessPack",
      ]);
      expect(found).toMatchObject({
        currentStep: "referral",
        visits: { intake: 1, referral: 1 },
      });
      // The log is the history: how the step ended, and what it added.
      expect(await log(t)).toEqual(
        expect.arrayContaining([
          'note "intake" returned done',
          'note "intake" appended referral',
          "step.started referral #1",
        ]),
      );
    });

    test("refuses a bad append and carries on", async () => {
      const { t, caseId } = await start();
      const found = await intakeReturns(t, caseId, {
        outcome: "done",
        append: [{ id: "pay", type: "payFee" }],
      });
      expect(found.currentStep).toBe("selectProcessPack");
      expect(found.plan).toEqual(bootstrapPlan);
      expect(await log(t)).toContain(
        'note "intake" append refused: Unknown stage type "payFee"',
      );
    });

    test("a result that can't be routed parks the case, like a failure", async () => {
      const { t, caseId } = await start();
      // Going back to a step that isn't in the plan is a bug in the stage.
      const found = await intakeReturns(t, caseId, {
        outcome: "back",
        backTo: "nope",
      });
      expect(found).toMatchObject({ status: "active", currentStep: "intake" });
      expect(found.failure?.error).toMatch(/missing "nope"/);
      expect(found.workflowId).toBeUndefined();
    });

    test("refused steps at the end of the plan stop the case, not finish it", async () => {
      const { t, caseId } = await start();
      await send(t, caseId, { type: "intake.submit", goal: "I moved" });
      // Selection finishing with a pack plan that can't be added (its id clashes).
      const found = await intakeReturns(
        t,
        caseId,
        { outcome: "done", append: [{ id: "intake", type: "intake" }] },
        { stepId: "selectProcessPack", visit: 1 },
      );
      expect(found.status).toBe("stopped");
      expect(found.endReason).toMatch(/Steps refused/);
    });

    test("a stop ends the case as stopped, with a reason", async () => {
      const { t, caseId } = await start();
      const found = await intakeReturns(t, caseId, {
        outcome: "stop",
        reason: "Not eligible",
      });
      expect(found).toMatchObject({
        status: "stopped",
        endReason: "Not eligible",
      });
      expect(found.currentStep).toBeUndefined();
      expect(found.workflowId).toBeUndefined();
    });

    test("a stale callback changes nothing", async () => {
      const { t, caseId } = await start();
      const before = await read(t, caseId);
      // From a visit the case isn't on, then from a step it isn't at.
      const done: StageResult = { outcome: "done" };
      await intakeReturns(t, caseId, done, { stepId: "intake", visit: 2 });
      await intakeReturns(t, caseId, done, {
        stepId: "selectProcessPack",
        visit: 1,
      });
      expect(await read(t, caseId)).toEqual(before);
      // And after the case has ended.
      const ended = await send(t, caseId, { type: "case.cancel" });
      await t.mutation(internal.easygov.plans.data.stageDone, {
        workflowId: before.workflowId!,
        result: { kind: "success", returnValue: done },
        context: { caseId, stepId: "intake", visit: 1 },
      });
      expect(await read(t, caseId)).toEqual(ended);
    });
  });
});
