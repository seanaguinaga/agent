import { afterEach, describe, expect, test, vi } from "vitest";
import { answer, model, resetCases, send, start } from "../case/cases.testkit";
import { choose, request } from "./packs.testkit";

vi.mock("../../modelsForDemo", async () =>
  (await import("../case/cases.testkit")).mockModels(),
);

describe("SSA appeal", () => {
  afterEach(resetCases);

  test("a referral is offered only when representation is wanted, and shared only on a yes", async () => {
    for (const [wantsRepresentation, reply] of [
      ["yes", "referral.share"],
      ["yes", "referral.decline"],
      ["no", undefined],
    ] as const) {
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
      let found = await send(t, caseId, { type: "review.approve" });
      if (reply) {
        expect(found).toMatchObject({
          status: "active",
          waitingFor: "consent",
        });
        found = await send(t, caseId, { type: reply });
      }
      expect(found.status).toBe("done");
      const referrals = await t.run((ctx) =>
        ctx.db.query("referrals").collect(),
      );
      expect(referrals).toEqual(
        reply === "referral.share"
          ? [
              expect.objectContaining({
                kind: "representation",
                answers: expect.objectContaining({ denialDate: "2026-10-01" }),
              }),
            ]
          : [],
      );
      expect(found.delivery).toEqual({ status: "prepared", channel: "online" });
    }
  });
});
