import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import { read, resetCases, send, start } from "./cases.testkit";
import type { CaseEvent } from "./validators";

vi.mock("../modelsForDemo", async () =>
  (await import("./cases.testkit")).mockModels(),
);

describe("the case API", () => {
  afterEach(resetCases);

  test("send refuses stale, unexpected and invalid events", async () => {
    const { t, caseId } = await start();
    const { seq } = await read(t, caseId);
    const sendAt = (expectedSeq: number, event: CaseEvent) =>
      t.mutation(api.easygov.cases.send, { caseId, event, expectedSeq });

    await expect(
      sendAt(seq - 1, { type: "intake.submit", goal: "I moved" }),
    ).rejects.toThrow(/changed/);
    await expect(sendAt(seq, { type: "review.approve" })).rejects.toThrow(
      /isn't expected/,
    );
    await expect(sendAt(seq, { type: "step.retry" })).rejects.toThrow(
      /No failed step/,
    );
    await expect(
      sendAt(seq, { type: "intake.submit", goal: "  " }),
    ).rejects.toThrow(/Say what/);

    await send(t, caseId, { type: "intake.submit", goal: "I moved" });
    const routed = await read(t, caseId);
    await expect(
      sendAt(routed.seq, { type: "route.confirm", processKey: "nope" }),
    ).rejects.toThrow(/Unknown process/);
  });

  test("canceling stops the case and its workflows", async () => {
    const { t, caseId } = await start();
    const found = await send(t, caseId, { type: "case.cancel" });
    expect(found).toMatchObject({
      status: "canceled",
      endReason: "Canceled by the user",
    });
    await expect(
      t.mutation(api.easygov.cases.send, {
        caseId,
        event: { type: "intake.submit", goal: "I moved" },
        expectedSeq: found.seq,
      }),
    ).rejects.toThrow(/canceled/);
  });
});
