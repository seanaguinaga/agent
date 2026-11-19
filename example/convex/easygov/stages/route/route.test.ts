import { afterEach, describe, expect, test, vi } from "vitest";
import { model, resetCases, send, start, texts } from "../../cases.testkit";

vi.mock("../../../modelsForDemo", async () =>
  (await import("../../cases.testkit")).mockModels(),
);

describe("the route stage", () => {
  afterEach(resetCases);

  test("rejecting the route goes back to intake for a new goal", async () => {
    const { t, caseId } = await start();
    await send(t, caseId, { type: "intake.submit", goal: "Something" });
    let found = await send(t, caseId, { type: "route.reject" });
    expect(found.stage).toBe("intake");
    expect(found.stepStatus.intake).toMatchObject({
      status: "active",
      visits: 2,
    });

    // The new goal clears the rejected route, and the agent proposes again.
    found = await send(t, caseId, { type: "intake.submit", goal: "I moved" });
    expect(found.stage).toBe("route");
    expect(found.route).toEqual({ status: "proposed", processKey: "irs8822" });
  });

  test("route stops the case when no known process fits", async () => {
    const { t, caseId } = await start();
    model.replies.push(
      '{"processKey":"none","message":"We can\'t help with that yet."}',
    );
    const found = await send(t, caseId, {
      type: "intake.submit",
      goal: "Sue my landlord",
    });
    expect(found).toMatchObject({
      status: "stopped",
      endReason: "No supported process fits yet",
    });
    expect((await texts(t, caseId)).at(-1)).toEqual([
      "assistant",
      "We can't help with that yet.",
    ]);
  });
});
