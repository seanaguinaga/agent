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

  test("runs from intake to delivery", async () => {
    const { t, caseId } = await start();
    let found = await read(t, caseId);
    expect(found).toMatchObject({ status: "active", waitingFor: "goal" });

    found = await send(t, caseId, { type: "goal.set", goal: "I moved" });
    expect(found.waitingFor).toBe("pack");

    found = await send(t, caseId, { type: "pack.accept" });
    expect(found).toMatchObject({
      waitingFor: "answers",
      selection: { status: "accepted" },
    });

    found = await answer(t, caseId, address);
    expect(found.waitingFor).toBe("review");
    expect(JSON.parse(found.artifact!.summary).answers).toEqual(address);

    // Changing an answer in review goes around again: the document is
    // rebuilt, and review waits for the new one to be accepted.
    found = await answer(t, caseId, { newAddress: "3 Newer Street" });
    expect(found.waitingFor).toBe("review");
    expect(found.artifact!.summary).toContain("3 Newer Street");

    found = await send(t, caseId, { type: "artifact.accept" });
    expect(found).toMatchObject({
      status: "done",
      waitingFor: null,
      delivery: { status: "prepared", channel: "mail" },
    });
    expect(found.run).toBeUndefined();
  });
});
