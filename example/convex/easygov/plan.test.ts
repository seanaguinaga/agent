import { describe, expect, test } from "vitest";
import { listPacks } from "./packs";
import {
  bootstrapPlan,
  evaluate,
  insertAfter,
  MAX_APPENDED_STEPS,
  nextRunnableStep,
  validateAppend,
  validatePlanStep,
} from "./plan";
import type { PlanStep } from "./validators";

describe("conditions", () => {
  const answers = { wantsRepresentation: "yes" };

  test("input equals", () => {
    const when = { input: "wantsRepresentation", equals: "yes" };
    expect(evaluate(when, answers, [])).toBe(true);
    expect(evaluate(when, {}, [])).toBe(false);
  });

  test("flag", () => {
    expect(evaluate({ flag: "urgent" }, {}, ["urgent"])).toBe(true);
    expect(evaluate({ flag: "urgent" }, {}, [])).toBe(false);
  });

  test("all and any", () => {
    const parts = [
      { input: "wantsRepresentation", equals: "yes" },
      { flag: "urgent" },
    ];
    expect(evaluate({ all: parts }, answers, [])).toBe(false);
    expect(evaluate({ any: parts }, answers, [])).toBe(true);
    expect(evaluate({ all: parts }, answers, ["urgent"])).toBe(true);
  });
});

describe("plan", () => {
  const step = (id: string, extra: Partial<PlanStep> = {}): PlanStep => ({
    id,
    type: "collect",
    ...extra,
  });

  test("insertAfter splices steps in after the named one", () => {
    const plan = insertAfter([step("a"), step("b")], "a", [step("x")]);
    expect(plan.map((s) => s.id)).toEqual(["a", "x", "b"]);
    expect(() => insertAfter([step("a")], "nope", [])).toThrow();
  });

  test("nextRunnableStep skips steps whose `when` fails", () => {
    const plan = [
      step("a"),
      step("b", { when: { flag: "urgent" } }),
      step("c"),
    ];
    expect(nextRunnableStep(plan, "a", {}, [])?.id).toBe("c");
    expect(nextRunnableStep(plan, "a", {}, ["urgent"])?.id).toBe("b");
    expect(nextRunnableStep(plan, "c", {}, [])).toBeNull();
  });

  test("validatePlanStep refuses duplicates, unknown types and bad params", () => {
    const ok: PlanStep = {
      id: "pay",
      type: "deliver",
      params: { channel: "mail" },
    };
    expect(validatePlanStep(ok, ["intake"])).toBeNull();
    expect(validatePlanStep(ok, ["pay"])).toMatch(/Duplicate/);
    expect(validatePlanStep({ id: "x", type: "payFee" }, [])).toMatch(
      /Unknown stage type/,
    );
    expect(validatePlanStep({ id: "x", type: "deliver" }, [])).toMatch(
      /Bad params/,
    );
  });

  test("validateAppend caps appended steps and catches duplicates in a batch", () => {
    const one = step("x");
    expect(validateAppend(bootstrapPlan, [one], 0)).toBeNull();
    expect(validateAppend(bootstrapPlan, [one], MAX_APPENDED_STEPS)).toMatch(
      /More than/,
    );
    expect(validateAppend(bootstrapPlan, [one, one], 0)).toMatch(/Duplicate/);
  });

  test("every pack's plan is valid", () => {
    for (const pack of listPacks()) {
      expect(validateAppend(bootstrapPlan, pack.plan, 0)).toBeNull();
    }
  });
});
