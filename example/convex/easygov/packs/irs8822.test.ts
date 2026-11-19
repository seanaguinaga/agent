import { afterEach, describe, expect, test, vi } from "vitest";
import { answer, read, resetCases, send, start } from "../case/cases.testkit";

vi.mock("../../modelsForDemo", async () =>
  (await import("../case/cases.testkit")).mockModels(),
);

const address = {
  fullName: "Ada Lovelace",
  oldAddress: "1 Old Road",
  newAddress: "2 New Street",
};

describe("IRS 8822", () => {
  afterEach(resetCases);

  test("runs the IRS 8822 plan from intake to delivery", async () => {
    const { t, caseId } = await start();
    let found = await read(t, caseId);
    expect(found).toMatchObject({ status: "active", currentStep: "intake" });
    expect(found.plan.map((s) => s.id)).toEqual([
      "intake",
      "selectProcessPack",
    ]);

    found = await send(t, caseId, { type: "intake.submit", goal: "I moved" });
    expect(found.currentStep).toBe("selectProcessPack");

    found = await send(t, caseId, { type: "processPack.confirm" });
    expect(found).toMatchObject({
      currentStep: "collect",
      processPack: { status: "confirmed" },
    });
    expect(found.plan.map((s) => s.id)).toEqual([
      "intake",
      "selectProcessPack",
      "collect",
      "fill",
      "review",
      "deliver",
    ]);

    found = await answer(t, caseId, address);
    expect(found.currentStep).toBe("review");
    expect(JSON.parse(found.artifact!.summary).answers).toEqual(address);

    // Changing an answer in review sends the case back through collect and
    // fill, so the artifact is rebuilt and review starts a second visit.
    found = await answer(t, caseId, { newAddress: "3 Newer Street" });
    expect(found).toMatchObject({
      currentStep: "review",
      visits: { collect: 2, fill: 2, review: 2 },
    });
    expect(found.artifact!.summary).toContain("3 Newer Street");

    found = await send(t, caseId, { type: "review.approve" });
    expect(found).toMatchObject({
      status: "done",
      delivery: { status: "prepared", channel: "mail" },
    });
    expect(found.currentStep).toBeUndefined();
  });
});
