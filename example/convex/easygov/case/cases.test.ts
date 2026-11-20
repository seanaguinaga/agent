import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../../_generated/api";
import { model, read, resetCases, send, start, texts } from "./cases.testkit";
import { workflow } from "./workflow";
import type { CaseEvent } from "./schema";

vi.mock("../../modelsForDemo", async () =>
  (await import("./cases.testkit")).mockModels(),
);

describe("the case API", () => {
  afterEach(resetCases);

  test("send refuses stale, unexpected and invalid events", async () => {
    const { t, caseId } = await start();
    const { seq } = await read(t, caseId);
    const sendAt = (expectedSeq: number, event: CaseEvent) =>
      t.mutation(api.easygov.case.public.sendEvent, {
        caseId,
        event,
        expectedSeq,
      });

    await expect(
      sendAt(seq - 1, { type: "goal.set", goal: "I moved" }),
    ).rejects.toThrow(/changed/);
    await expect(sendAt(seq, { type: "artifact.accept" })).rejects.toThrow(
      /isn't expected/,
    );
    await expect(sendAt(seq, { type: "case.retry" })).rejects.toThrow(
      /Nothing has failed/,
    );
    await expect(sendAt(seq, { type: "goal.set", goal: "  " })).rejects.toThrow(
      /Say what/,
    );
  });

  test("every write bumps seq", async () => {
    const { t, caseId } = await start();
    const { seq } = await read(t, caseId);
    await t.mutation(api.easygov.case.public.sendMessage, {
      caseId,
      text: "Hi",
      messageKey: "a",
    });
    // The message, and the work it started.
    expect((await read(t, caseId)).seq).toBe(seq + 2);
  });

  test("the same chat message sent twice is saved and answered once", async () => {
    const { t, caseId } = await start();
    model.replies.push('{"reply":"What do you need?","goal":null}');
    const message = { caseId, text: "Hi", messageKey: "one" };
    await t.mutation(api.easygov.case.public.sendMessage, message);
    // A double submit, then a client retry after the agent has answered.
    await t.mutation(api.easygov.case.public.sendMessage, message);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    await t.mutation(api.easygov.case.public.sendMessage, message);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await texts(t, caseId)).toEqual([
      ["user", "Hi"],
      ["assistant", "What do you need?"],
    ]);

    // A new key is a new message, even with the same words.
    model.replies.push('{"reply":"Still here.","goal":null}');
    await t.mutation(api.easygov.case.public.sendMessage, {
      ...message,
      messageKey: "two",
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await texts(t, caseId)).toHaveLength(4);
  });

  test("canceling stops the case and its workflows", async () => {
    const { t, caseId } = await start();
    // Nothing runs until there's something to do.
    expect((await read(t, caseId)).run).toBeUndefined();
    // A goal starts the proposal. Cancel while it's still running.
    await t.mutation(api.easygov.case.public.sendEvent, {
      caseId,
      event: { type: "goal.set", goal: "I moved" },
      expectedSeq: (await read(t, caseId)).seq,
    });
    const { run } = await read(t, caseId);
    const found = await send(t, caseId, { type: "case.cancel" });
    expect(found).toMatchObject({
      status: "canceled",
      endReason: "Canceled by the user",
    });
    // The case's workflow was canceled with it.
    expect(found.run).toBeUndefined();
    if (run?.state !== "running") throw new Error("Expected running work");
    const status = await t.run((ctx) => workflow.status(ctx, run.workflowId));
    expect(status.type).toBe("canceled");
    await expect(
      t.mutation(api.easygov.case.public.sendEvent, {
        caseId,
        event: { type: "goal.set", goal: "I moved again" },
        expectedSeq: found.seq,
      }),
    ).rejects.toThrow(/canceled/);
  });
});
