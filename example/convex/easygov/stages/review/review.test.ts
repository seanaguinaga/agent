import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../../../_generated/api";
import { answer, resetCases, send, start } from "../../cases.testkit";

vi.mock("../../../modelsForDemo", async () =>
  (await import("../../cases.testkit")).mockModels(),
);

const address = {
  fullName: "Ada Lovelace",
  oldAddress: "1 Old Road",
  newAddress: "2 New Street",
};

describe("the review stage", () => {
  afterEach(resetCases);

  test("approval is refused when the artifact is out of date", async () => {
    const { t, caseId } = await start();
    await send(t, caseId, { type: "intake.submit", goal: "I moved" });
    await send(t, caseId, { type: "route.confirm", processKey: "irs8822" });
    const found = await answer(t, caseId, address);
    await t.run((ctx) =>
      ctx.db.patch("cases", caseId, {
        answers: { ...address, fullName: "Someone" },
      }),
    );
    await expect(
      t.mutation(api.easygov.cases.send, {
        caseId,
        event: { type: "review.approve" },
        expectedSeq: found.seq,
      }),
    ).rejects.toThrow(/answers changed/);
  });
});
