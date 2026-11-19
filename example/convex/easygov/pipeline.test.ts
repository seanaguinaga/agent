import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { read, resetCases, send, start, type T } from "./cases.testkit";
import { bootstrapPlan } from "./plan";
import type { PlanStep } from "./validators";

vi.mock("../modelsForDemo", async () =>
  (await import("./cases.testkit")).mockModels(),
);

describe("the pipeline", () => {
  afterEach(resetCases);

  /** Makes the route step fail when it starts, by breaking its params. */
  async function failRoute(t: T, caseId: Id<"cases">) {
    await t.run(async (ctx) => {
      const { plan } = (await ctx.db.get("cases", caseId))!;
      await ctx.db.patch("cases", caseId, {
        plan: plan.map((s) => (s.id === "route" ? { ...s, params: {} } : s)),
      });
    });
    return await send(t, caseId, { type: "intake.submit", goal: "I moved" });
  }

  test("a failed stage waits for a retry, which runs it again", async () => {
    const { t, caseId } = await start();
    let found = await failRoute(t, caseId);
    expect(found.status).toBe("active");
    expect(found.stepStatus.route).toMatchObject({
      status: "failed",
      visits: 1,
    });
    expect(found.stepStatus.route.error).toBeTruthy();

    // Fix the plan, then retry. A second retry can't be queued meanwhile.
    await t.run((ctx) =>
      ctx.db.patch("cases", caseId, { plan: bootstrapPlan }),
    );
    await t.mutation(api.easygov.cases.send, {
      caseId,
      event: { type: "step.retry" },
      expectedSeq: found.seq,
    });
    await expect(
      t.mutation(api.easygov.cases.send, {
        caseId,
        event: { type: "step.retry" },
        expectedSeq: found.seq + 1,
      }),
    ).rejects.toThrow(/No failed step/);
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    found = await read(t, caseId);
    expect(found.stepStatus.route).toMatchObject({
      status: "active",
      visits: 2,
    });
    expect(found.activeWorkflowId).toBeDefined();
  });

  test("canceling a failed stage stops the case, which is not success", async () => {
    const { t, caseId } = await start();
    await failRoute(t, caseId);
    const found = await send(t, caseId, { type: "step.cancel" });
    expect(found.status).toBe("stopped");
    expect(found.endReason).toMatch(/route/);
  });

  describe("advance", () => {
    const advance = (t: T, caseId: Id<"cases">, append: PlanStep[]) =>
      t.mutation(internal.easygov.pipeline.advance, {
        caseId,
        stepId: "intake",
        result: { outcome: "done", append },
      });
    const log = (t: T) =>
      t.run(async (ctx) =>
        (await ctx.db.query("caseEvents").collect()).map((e) => e.kind),
      );

    test("appends valid steps after the current one and logs it", async () => {
      const { t, caseId } = await start();
      const extra: PlanStep = {
        id: "referral",
        type: "legalReferral",
        params: { kind: "advice" },
      };
      const next = await advance(t, caseId, [extra]);
      expect(next).toMatchObject({ id: "referral", visits: 1 });
      const found = await read(t, caseId);
      expect(found.plan.map((s) => s.id)).toEqual([
        "intake",
        "referral",
        "route",
      ]);
      expect(found).toMatchObject({
        stage: "legalReferral",
        activeStepId: "referral",
        appended: 1,
      });
      expect(found.stepStatus.intake.status).toBe("done");
      expect(found.activeWorkflowId).toBeUndefined();
      expect(await log(t)).toContain("planAmended");
    });

    test("refuses a bad append and carries on with the plan", async () => {
      const { t, caseId } = await start();
      const next = await advance(t, caseId, [{ id: "pay", type: "payFee" }]);
      expect(next?.id).toBe("route");
      expect((await read(t, caseId)).plan).toEqual(bootstrapPlan);
      expect(await log(t)).toContain("appendRefused");
    });

    test("a stop ends the case as stopped, with a reason", async () => {
      const { t, caseId } = await start();
      const next = await t.mutation(internal.easygov.pipeline.advance, {
        caseId,
        stepId: "intake",
        result: { outcome: "stop", reason: "Not eligible" },
      });
      expect(next).toBeNull();
      expect(await read(t, caseId)).toMatchObject({
        status: "stopped",
        endReason: "Not eligible",
      });
    });
  });
});
