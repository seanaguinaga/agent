import { afterEach, describe, expect, test, vi } from "vitest";
import { answer, resetCases, send, start } from "../cases.testkit";

vi.mock("../../modelsForDemo", async () =>
  (await import("../cases.testkit")).mockModels(),
);

describe("SSA appeal", () => {
  afterEach(resetCases);

  test("the SSA appeal opens a referral only when representation is wanted", async () => {
    for (const wantsRepresentation of ["yes", "no"]) {
      const { t, caseId } = await start();
      await send(t, caseId, { type: "intake.submit", goal: "Appeal a denial" });
      await send(t, caseId, { type: "route.confirm", processKey: "ssaAppeal" });
      await answer(t, caseId, {
        fullName: "Ada Lovelace",
        denialDate: "2026-10-01",
        reasonForAppeal: "New evidence",
        wantsRepresentation,
      });
      const found = await send(t, caseId, { type: "review.approve" });
      expect(found.status).toBe("done");
      const referrals = await t.run((ctx) =>
        ctx.db.query("referrals").collect(),
      );
      expect(referrals).toHaveLength(wantsRepresentation === "yes" ? 1 : 0);
      expect(found.stepStatus.legalReferral?.status).toBe(
        wantsRepresentation === "yes" ? "done" : undefined,
      );
    }
  });
});
