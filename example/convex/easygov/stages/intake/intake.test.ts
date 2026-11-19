import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../../../_generated/api";
import { initConvexTest } from "../../../setup.test";
import {
  chat,
  model,
  read,
  resetCases,
  send,
  start,
  texts,
} from "../../case/cases.testkit";

vi.mock("../../../modelsForDemo", async () =>
  (await import("../../case/cases.testkit")).mockModels(),
);

describe("the intake stage", () => {
  afterEach(resetCases);

  test("intake chats until it knows the goal, then the next stage proposes a process pack", async () => {
    const { t, caseId } = await start();
    model.replies.push(
      '{"reply":"What do you need to change?","goal":null}',
      '{"reply":"Got it.","goal":"Tell the IRS my new address"}',
    );

    let found = await chat(t, caseId, "Hi, I need help with the IRS");
    expect(found.currentStep).toBe("intake");
    expect(found.pendingMessageId).toBeUndefined();

    found = await chat(t, caseId, "I moved house");
    expect(found.intake?.goal).toBe("Tell the IRS my new address");
    expect(found).toMatchObject({
      currentStep: "selectProcessPack",
      processPack: { status: "proposed" },
    });
    expect(await texts(t, caseId)).toEqual([
      ["user", "Hi, I need help with the IRS"],
      ["assistant", "What do you need to change?"],
      ["user", "I moved house"],
      ["assistant", "Got it."],
      ["assistant", "Suggested process: IRS change of address (Form 8822)."],
    ]);

    // The person still confirms the proposal.
    found = await send(t, caseId, { type: "processPack.confirm" });
    expect(found.currentStep).toBe("collect");
  });

  test("a message sent before intake listens is answered when it does", async () => {
    vi.useFakeTimers();
    const t = initConvexTest();
    const caseId = await t.mutation(api.easygov.case.public.startCase, {});
    model.replies.push('{"reply":"Got it.","goal":"Renew my license"}');
    await t.mutation(api.easygov.case.public.sendMessage, {
      caseId,
      text: "Renew my license",
      messageKey: "first",
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await read(t, caseId)).intake?.goal).toBe("Renew my license");
  });
});
