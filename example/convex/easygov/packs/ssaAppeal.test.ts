import { afterEach, describe, expect, test, vi } from "vitest";
import { answer, model, resetCases, send, start } from "../case/cases.testkit";
import { choose, request } from "./packs.testkit";

vi.mock("../../modelsForDemo", async () =>
  (await import("../case/cases.testkit")).mockModels(),
);

describe("SSA appeal", () => {
  afterEach(resetCases);

  test("the SSA appeal opens a referral only when representation is wanted", async () => {
    for (const wantsRepresentation of ["yes", "no"]) {
      const { t, caseId } = await start();
      model.replies.push(
        request({
          jurisdiction: "us",
          authority: "Social Security Administration",
          searchTerms: "appeal denied claim reconsideration",
        }),
        choose(1),
      );
      await send(t, caseId, { type: "intake.submit", goal: "Appeal a denial" });
      await send(t, caseId, { type: "processPack.confirm" });
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
      expect(referrals).toEqual(
        wantsRepresentation === "yes"
          ? [expect.objectContaining({ kind: "representation" })]
          : [],
      );
      expect(found.delivery).toEqual({ status: "prepared", channel: "online" });
    }
  });
});
