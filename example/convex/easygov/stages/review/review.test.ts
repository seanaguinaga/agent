import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../../../_generated/api";
import { answer, resetCases, send, start } from "../../case/cases.testkit";

vi.mock("../../../modelsForDemo", async () =>
  (await import("../../case/cases.testkit")).mockModels(),
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
    await send(t, caseId, { type: "processPack.confirm" });
    const found = await answer(t, caseId, address);
    await t.run((ctx) =>
      ctx.db.patch("cases", caseId, {
        answers: { ...address, fullName: "Someone" },
      }),
    );
    await expect(
      t.mutation(api.easygov.case.public.send, {
        caseId,
        event: { type: "review.approve" },
        expectedSeq: found.seq,
      }),
    ).rejects.toThrow(/answers changed/);
  });
});
