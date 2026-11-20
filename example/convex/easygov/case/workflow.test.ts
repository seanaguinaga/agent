// A case's workflow, end to end, with a mock model.
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../../_generated/api";
import { initConvexTest } from "../../setup.test";
import { request } from "../packs/packs.testkit";
import {
  answer,
  chat,
  model,
  read,
  resetCases,
  send,
  start,
  texts,
} from "./cases.testkit";
import { nudgeCase } from "./workflow";

vi.mock("../../modelsForDemo", async () =>
  (await import("./cases.testkit")).mockModels(),
);

const address = {
  fullName: "Ada Lovelace",
  oldAddress: "1 Old Road",
  newAddress: "2 New Street",
};

describe("agreeing on what to do", () => {
  afterEach(resetCases);

  test("intake chats until it knows the goal, then a pack is proposed", async () => {
    const { t, caseId } = await start();
    model.replies.push(
      '{"reply":"What do you need to change?","goal":null}',
      '{"reply":"Got it.","goal":"Tell the IRS my new address"}',
    );
    let found = await chat(t, caseId, "Hi, I need help with the IRS");
    expect(found).toMatchObject({ waitingFor: "goal" });
    expect(found.pendingMessageId).toBeUndefined();

    found = await chat(t, caseId, "I moved house");
    expect(found).toMatchObject({
      goal: { text: "Tell the IRS my new address" },
      waitingFor: "pack",
      selection: { status: "proposed" },
    });
    expect(await texts(t, caseId)).toEqual([
      ["user", "Hi, I need help with the IRS"],
      ["assistant", "What do you need to change?"],
      ["user", "I moved house"],
      ["assistant", "Got it."],
      ["assistant", "Suggested process: IRS change of address (Form 8822)."],
    ]);
  });

  test("a message sent before the workflow starts is answered when it does", async () => {
    vi.useFakeTimers();
    const t = initConvexTest();
    const caseId = await t.mutation(api.easygov.case.public.createCase, {});
    model.replies.push('{"reply":"Got it.","goal":"Renew my license"}');
    await t.mutation(api.easygov.case.public.sendMessage, {
      caseId,
      text: "I need to renew my license",
      messageKey: "early",
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const found = await read(t, caseId);
    expect(found.goal?.text).toBe("Renew my license");
    expect(found.pendingMessageId).toBeUndefined();
  });

  test("rejecting the pack goes back to intake, and a new goal gets a new proposal", async () => {
    const { t, caseId } = await start();
    await send(t, caseId, { type: "goal.set", goal: "Something" });
    let found = await send(t, caseId, { type: "pack.reject" });
    expect(found).toMatchObject({
      waitingFor: "goal",
      selection: { status: "rejected", reason: "person" },
    });
    found = await send(t, caseId, { type: "goal.set", goal: "I moved" });
    expect(found).toMatchObject({
      waitingFor: "pack",
      selection: { status: "proposed" },
    });
  });

  test("answers already given in chat are offered back, not asked again", async () => {
    const { t, caseId } = await start();
    model.replies.push(
      '{"reply":"Got it.","goal":"Tell the IRS my new address"}',
    );
    await chat(t, caseId, "I moved to 2 New Street and need to tell the IRS");
    // Read after the pack is accepted. The model also offers a key the pack
    // doesn't ask for; that one is dropped.
    model.replies.push(
      JSON.stringify({
        answers: [
          { key: "newAddress", value: "2 New Street" },
          { key: "shoeSize", value: "9" },
        ],
      }),
    );
    // Said while the pack is proposed: no intake is running to answer it.
    const { sendMessage } = api.easygov.case.public;
    await t.mutation(sendMessage, {
      caseId,
      text: "Yes, that one",
      messageKey: "while proposed",
    });
    expect((await read(t, caseId)).pendingMessageId).toBeDefined();
    let found = await send(t, caseId, { type: "pack.accept" });
    expect(found).toMatchObject({
      waitingFor: "answers",
      answers: {},
      suggestions: { newAddress: "2 New Street" },
    });
    // Accepting ends intake: nothing is left pending, and chat is closed.
    expect(found.pendingMessageId).toBeUndefined();
    await expect(
      t.mutation(sendMessage, { caseId, text: "Hello?", messageKey: "late" }),
    ).rejects.toThrow(/process is chosen/);
    // A suggestion isn't an answer until the person takes it.
    found = await send(t, caseId, { type: "answers.accept" });
    expect(found).toMatchObject({
      waitingFor: "answers",
      answers: { newAddress: "2 New Street" },
      suggestions: {},
    });
    await expect(send(t, caseId, { type: "answers.accept" })).rejects.toThrow(
      /nothing suggested/,
    );
    const history = await t.query(api.easygov.dev.history, { caseId });
    expect(history.map(({ kind, detail }) => [kind, detail])).toContainEqual([
      "answers.suggested",
      "newAddress",
    ]);
  });

  test("a clarifying question goes back to intake", async () => {
    const { t, caseId } = await start();
    model.replies.push(
      request({ kind: "unclear", message: "Where is the property located?" }),
    );
    const found = await send(t, caseId, {
      type: "goal.set",
      goal: "Sue my landlord",
    });
    expect(found).toMatchObject({
      status: "active",
      waitingFor: "goal",
      selection: { status: "rejected" },
    });
    expect((await texts(t, caseId)).at(-1)).toEqual([
      "assistant",
      "Where is the property located?",
    ]);
    // The history tells the goal, and the question, from a proposal.
    const history = await t.query(api.easygov.dev.history, { caseId });
    expect(history.map(({ kind, detail }) => [kind, detail])).toEqual([
      ["case.started", undefined],
      ["goal.set", "Sue my landlord"],
      ["pack.clarification", "Where is the property located?"],
    ]);
  });

  test("a request for legal advice is accepted as a referral, not a pack", async () => {
    const { t, caseId } = await start();
    model.replies.push(
      request({
        kind: "referral",
        message: "I'll connect you with legal help.",
      }),
    );
    let found = await send(t, caseId, {
      type: "goal.set",
      goal: "Should I sue my former employer?",
    });
    expect(found.selection).toMatchObject({
      status: "proposed",
      kind: "referral",
    });
    // Accepting it isn't sharing it: the person is asked first.
    found = await send(t, caseId, { type: "pack.accept" });
    expect(found).toMatchObject({ status: "active", waitingFor: "consent" });
    const referrals = () => t.run((ctx) => ctx.db.query("referrals").collect());
    expect(await referrals()).toEqual([]);

    found = await send(t, caseId, { type: "referral.share" });
    expect(found).toMatchObject({
      status: "done",
      waitingFor: null,
      referral: { kind: "advice", status: "shared" },
    });
    expect(await referrals()).toMatchObject([
      { kind: "advice", goal: "Should I sue my former employer?" },
    ]);
  });
});

describe("answers and review", () => {
  afterEach(resetCases);

  test("accepted is only taken while the document matches the answers", async () => {
    const { t, caseId } = await start();
    await send(t, caseId, { type: "goal.set", goal: "I moved" });
    await send(t, caseId, { type: "pack.accept" });
    const found = await answer(t, caseId, address);
    expect(found.waitingFor).toBe("review");
    // Answers changed behind the document's back: no longer in review.
    await t.run((ctx) =>
      ctx.db.patch("cases", caseId, {
        answers: { ...address, fullName: "Someone" },
      }),
    );
    await expect(
      t.mutation(api.easygov.case.public.sendEvent, {
        caseId,
        event: { type: "artifact.accept" },
        expectedSeq: found.seq,
      }),
    ).rejects.toThrow(/isn't expected/);
  });
});

describe("a busy person", () => {
  afterEach(resetCases);

  test("many edits to the answers don't fail the case", async () => {
    const { t, caseId } = await start();
    await send(t, caseId, { type: "goal.set", goal: "I moved" });
    await send(t, caseId, { type: "pack.accept" });
    // Far more edits than the workflow has looks to spend on one wait.
    for (let i = 0; i < 120; i++) {
      await t.mutation(api.easygov.case.public.sendEvent, {
        caseId,
        event: { type: "answers.set", key: "oldAddress", value: `${i} Old Rd` },
        expectedSeq: 0,
      });
    }
    await t.finishAllScheduledFunctions(vi.runAllTimers, 5000);
    let found = await read(t, caseId);
    expect(found.run?.state).toBe("running");
    expect(found).toMatchObject({ status: "active", waitingFor: "answers" });

    // The edit that completes the answers is still noticed.
    found = await answer(t, caseId, {
      fullName: address.fullName,
      newAddress: address.newAddress,
    });
    expect(found).toMatchObject({ waitingFor: "review" });
  });
});

describe("failures", () => {
  afterEach(resetCases);

  test("a failure parks the case; retry runs the workflow again from the top", async () => {
    const { t, caseId } = await start();
    model.failing = true;
    let found = await send(t, caseId, {
      type: "goal.set",
      goal: "I moved",
    });
    expect(found).toMatchObject({ status: "active", waitingFor: null });
    expect(found).toMatchObject({
      phase: "failed",
      run: { state: "failed", error: expect.stringMatching(/model is down/) },
    });
    await expect(
      t.mutation(api.easygov.case.public.sendEvent, {
        caseId,
        event: { type: "goal.set", goal: "Again" },
        expectedSeq: found.seq,
      }),
    ).rejects.toThrow(/isn't expected/);

    model.failing = false;
    found = await send(t, caseId, { type: "case.retry" });
    expect(found.run?.state).toBe("running");
    expect(found).toMatchObject({
      waitingFor: "pack",
      goal: { text: "I moved", version: 1 },
    });
    await expect(send(t, caseId, { type: "case.retry" })).rejects.toThrow(
      /Nothing has failed/,
    );
  });

  test("a failed case can be given up on, or canceled", async () => {
    for (const type of ["case.stop", "case.cancel"] as const) {
      const { t, caseId } = await start();
      model.failing = true;
      await send(t, caseId, { type: "goal.set", goal: "I moved" });
      const found = await send(t, caseId, { type });
      expect(found.status).toBe(type === "case.stop" ? "stopped" : "canceled");
      // An ended case has no run, failed or otherwise.
      expect(found.run).toBeUndefined();
      model.failing = false;
    }
  });

  test("a restart mid-case keeps what the person already did", async () => {
    const { t, caseId } = await start();
    await send(t, caseId, { type: "goal.set", goal: "I moved" });
    await send(t, caseId, { type: "pack.accept" });
    await answer(t, caseId, { fullName: address.fullName });

    // Break the case under the waiting workflow, so its next look fails.
    const saved = (await read(t, caseId)).selection!;
    await t.run(async (ctx) => {
      await ctx.db.patch("cases", caseId, {
        selection: { ...saved, goalVersion: 99 },
      });
      await nudgeCase(ctx, (await ctx.db.get("cases", caseId))!);
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await read(t, caseId)).run?.state).toBe("failed");

    // Repair it and retry: the workflow replays from the top, finds the goal
    // and the accepted pack in place, and waits for the rest of the answers.
    await t.run((ctx) => ctx.db.patch("cases", caseId, { selection: saved }));
    let found = await send(t, caseId, { type: "case.retry" });
    expect(found).toMatchObject({
      waitingFor: "answers",
      answers: { fullName: address.fullName },
    });
    found = await answer(t, caseId, {
      oldAddress: address.oldAddress,
      newAddress: address.newAddress,
    });
    expect(found.waitingFor).toBe("review");
    expect(
      (await texts(t, caseId)).filter(([role]) => role === "assistant"),
    ).toHaveLength(1);
  });
});
