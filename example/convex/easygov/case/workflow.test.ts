// A case's workflows, end to end, with a mock model.
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../../_generated/api";
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
import { limits } from "../limits";
import { MAX_BUILDS } from "./state";
import { workflow } from "./workflow";

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

  test("a message sent as soon as the case exists is answered", async () => {
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

  test("the person may reject and rephrase as often as they like", async () => {
    const { t, caseId } = await start();
    let found = await read(t, caseId);
    for (let round = 1; round <= 8; round++) {
      await send(t, caseId, { type: "goal.set", goal: `Goal ${round}` });
      found = await send(t, caseId, { type: "pack.reject" });
    }
    expect(found).toMatchObject({ status: "active", waitingFor: "goal" });
    for (let turn = 1; turn <= 15; turn++) {
      model.replies.push('{"reply":"Tell me more.","goal":null}');
      found = await chat(t, caseId, `Message ${turn}`);
    }
    expect(found).toMatchObject({ status: "active", waitingFor: "goal" });
    expect(found.run).toBeUndefined();
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

describe("what a person corrects", () => {
  afterEach(resetCases);

  const kinds = async (
    t: Awaited<ReturnType<typeof start>>["t"],
    caseId: Awaited<ReturnType<typeof start>>["caseId"],
  ) =>
    (await t.query(api.easygov.dev.history, { caseId }))
      .filter(({ kind }) =>
        ["pack.rejected", "answer.changed", "artifact.reassessed"].includes(
          kind,
        ),
      )
      .map(({ kind, detail }) => [kind, detail]);

  test("a rejected pack, an answer changed in review and a reassessed document are recorded", async () => {
    const { t, caseId } = await start();
    await send(t, caseId, { type: "goal.set", goal: "Something" });
    await send(t, caseId, { type: "pack.reject" });
    await send(t, caseId, { type: "goal.set", goal: "I moved" });
    await send(t, caseId, { type: "pack.accept" });
    // Answering for the first time corrects nothing.
    expect((await answer(t, caseId, address)).waitingFor).toBe("review");
    expect(await kinds(t, caseId)).toEqual([["pack.rejected", undefined]]);

    const found = await answer(t, caseId, { fullName: "Ada King" });
    expect(found.waitingFor).toBe("review");
    await send(t, caseId, { type: "artifact.reassess" });
    expect(await kinds(t, caseId)).toEqual([
      ["pack.rejected", undefined],
      ["answer.changed", "fullName, in review"],
      ["artifact.reassessed", undefined],
    ]);
  });

  test("an answer other than the one read from the chat is recorded, by key only", async () => {
    const { t, caseId } = await start();
    model.replies.push(
      '{"reply":"Got it.","goal":"Tell the IRS my new address"}',
    );
    await chat(t, caseId, "I moved to 2 New Street and need to tell the IRS");
    model.replies.push(
      JSON.stringify({
        answers: [{ key: "newAddress", value: "2 New Street" }],
      }),
    );
    await t.mutation(api.easygov.case.public.sendMessage, {
      caseId,
      text: "Yes, that one",
      messageKey: "while proposed",
    });
    await send(t, caseId, { type: "pack.accept" });
    // The same answer as the one read is no correction.
    await answer(t, caseId, { newAddress: "2 New Street" });
    expect(await kinds(t, caseId)).toEqual([]);
    await answer(t, caseId, { newAddress: "12 New Street" });
    expect(await kinds(t, caseId)).toEqual([]);

    const other = await start();
    model.replies.push(
      '{"reply":"Got it.","goal":"Tell the IRS my new address"}',
    );
    await chat(other.t, other.caseId, "I moved to 2 New Street");
    model.replies.push(
      JSON.stringify({
        answers: [{ key: "newAddress", value: "2 New Street" }],
      }),
    );
    await other.t.mutation(api.easygov.case.public.sendMessage, {
      caseId: other.caseId,
      text: "Yes",
      messageKey: "while proposed",
    });
    await send(other.t, other.caseId, { type: "pack.accept" });
    await answer(other.t, other.caseId, { newAddress: "3 Other Road" });
    expect(await kinds(other.t, other.caseId)).toEqual([
      ["answer.changed", "newAddress, not as read"],
    ]);
  });
});

describe("a busy person", () => {
  afterEach(resetCases);

  test("many edits to the answers don't fail the case", async () => {
    const { t, caseId } = await start();
    await send(t, caseId, { type: "goal.set", goal: "I moved" });
    await send(t, caseId, { type: "pack.accept" });
    // Nothing runs while the person edits, however many times.
    for (let i = 0; i < 120; i++) {
      await t.mutation(api.easygov.case.public.sendEvent, {
        caseId,
        event: { type: "answers.set", key: "oldAddress", value: `${i} Old Rd` },
        expectedSeq: 0,
      });
    }
    await t.finishAllScheduledFunctions(vi.runAllTimers, 5000);
    let found = await read(t, caseId);
    expect(found.run).toBeUndefined();
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

  test("a failure parks the case; retry starts the work again", async () => {
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
    // Proposed, and nothing left to run until the person decides.
    expect(found.run).toBeUndefined();
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

  test("a retry mid-case keeps what the person already did", async () => {
    const { t, caseId } = await start();
    await send(t, caseId, { type: "goal.set", goal: "I moved" });
    await send(t, caseId, { type: "pack.accept" });
    await answer(t, caseId, { fullName: address.fullName });

    // Stand in for any failed work: park the case on a dead workflow.
    const { workflowId } = await t.run(async (ctx) => {
      const workflowId = await workflow.start(
        ctx,
        internal.easygov.case.workflow.propose,
        { caseId },
        { startAsync: true },
      );
      await workflow.cancel(ctx, workflowId);
      await ctx.db.patch("cases", caseId, {
        run: { state: "failed", workflowId, error: "boom" },
      });
      return { workflowId };
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await read(t, caseId)).toMatchObject({
      phase: "failed",
      run: { workflowId },
    });

    // Retry: the case needs nothing run right now, so it waits for the rest
    // of the answers, with the goal, the pack and the first answer in place.
    let found = await send(t, caseId, { type: "case.retry" });
    expect(found.run).toBeUndefined();
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

  test("building too many times without acceptance stops the case", async () => {
    const { t, caseId } = await start();
    await send(t, caseId, { type: "goal.set", goal: "I moved" });
    await send(t, caseId, { type: "pack.accept" });
    let found = await answer(t, caseId, address);
    expect(found).toMatchObject({ waitingFor: "review", builds: 1 });
    // The count is on the case: set it to one short of the limit.
    await t.run((ctx) =>
      ctx.db.patch("cases", caseId, { builds: MAX_BUILDS - 1 }),
    );
    found = await answer(t, caseId, { fullName: "Ada King" });
    expect(found).toMatchObject({ waitingFor: "review", builds: MAX_BUILDS });
    found = await answer(t, caseId, { fullName: "Ada Lovelace" });
    expect(found).toMatchObject({
      status: "stopped",
      endReason: `Built ${MAX_BUILDS} times without acceptance`,
    });
  });

  test("accepting the document starts the build count again", async () => {
    const { t, caseId } = await start();
    await send(t, caseId, { type: "goal.set", goal: "I moved" });
    await send(t, caseId, { type: "pack.accept" });
    await answer(t, caseId, address);
    const found = await send(t, caseId, { type: "artifact.accept" });
    expect(found.builds).toBeUndefined();
  });
});

describe("what a case may cost", () => {
  afterEach(resetCases);

  test("chat messages sent too fast are refused", async () => {
    const { t, caseId } = await start();
    const say = (n: number) =>
      t.mutation(api.easygov.case.public.sendMessage, {
        caseId,
        text: `Message ${n}`,
        messageKey: `fast-${n}`,
      });
    for (let n = 1; n <= 10; n++) await say(n);
    await expect(say(11)).rejects.toThrow(/caseMessages/);
  });

  test("work over the person's budget waits its turn, then runs", async () => {
    const { t, caseId } = await start();
    const { userId } = await read(t, caseId);
    // Spend the person's whole budget for starting work.
    await t.run((ctx) =>
      limits.limit(ctx, "caseWorkPerUser", { key: userId, count: 40 }),
    );
    await t.mutation(api.easygov.case.public.sendEvent, {
      caseId,
      event: { type: "goal.set", goal: "I moved" },
      expectedSeq: (await read(t, caseId)).seq,
    });
    let found = await read(t, caseId);
    expect(found).toMatchObject({
      phase: "proposing",
      run: { state: "delayed" },
    });
    // Its turn comes, and the proposal is made.
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    found = await read(t, caseId);
    expect(found).toMatchObject({ waitingFor: "pack" });
    expect(found.run).toBeUndefined();
  });

  test("an eval's case skips the limits", async () => {
    const { t, caseId } = await start();
    const { userId } = await read(t, caseId);
    await t.mutation(internal.easygov.evals.runner.unmeter, { caseId });
    await t.run(async (ctx) => {
      await limits.limit(ctx, "caseWorkPerUser", { key: userId, count: 40 });
      await limits.limit(ctx, "caseWorkPerCase", { key: caseId, count: 30 });
    });
    const found = await send(t, caseId, { type: "goal.set", goal: "I moved" });
    expect(found).toMatchObject({ waitingFor: "pack" });
  });

  test("tokens spent are charged, and a budget in debt delays the next work", async () => {
    const { t, caseId } = await start();
    const { userId } = await read(t, caseId);
    const left = () =>
      t.run(async (ctx) => {
        const { value } = await limits.getValue(ctx, "caseTokensPerUser", {
          key: userId,
        });
        return value;
      });
    const before = await left();
    await send(t, caseId, { type: "goal.set", goal: "I moved" });
    expect(await left()).toBeLessThan(before);

    // In debt: the next piece of work waits.
    await t.run((ctx) =>
      limits.limit(ctx, "caseTokensPerUser", {
        key: userId,
        count: 2_000_000,
        reserve: true,
      }),
    );
    await send(t, caseId, { type: "pack.reject" });
    await t.mutation(api.easygov.case.public.sendEvent, {
      caseId,
      event: { type: "goal.set", goal: "I moved again" },
      expectedSeq: (await read(t, caseId)).seq,
    });
    expect((await read(t, caseId)).run?.state).toBe("delayed");
  });

  test("a model call asked for directly is refused over budget, and charged", async () => {
    vi.useFakeTimers();
    const t = initConvexTest();
    const { parseAddress } = api.easygov.profile.agents;
    const left = () =>
      t.run(async (ctx) => {
        const { value } = await limits.getValue(ctx, "caseTokensPerUser", {
          key: "test user",
        });
        return value;
      });
    const before = await left();
    model.replies.push(
      JSON.stringify({
        isAddress: true,
        street: "2 New Street",
        unitType: "",
        unitNumber: "",
        city: "Springfield",
        state: "IL",
        postalCode: "62701",
        country: "US",
        careOf: "",
      }),
    );
    const parsed = await t.action(parseAddress, {
      text: "2 New Street, Springfield IL 62701",
    });
    expect(parsed).toMatchObject({ city: "Springfield" });
    expect(await left()).toBeLessThan(before);

    // With the rest of the budget for starting work spent (the call above
    // took one), the next call is refused.
    await t.run((ctx) =>
      limits.limit(ctx, "caseWorkPerUser", { key: "test user", count: 39 }),
    );
    await expect(
      t.action(parseAddress, { text: "1 Old Road" }),
    ).rejects.toThrow(/caseWorkPerUser/);
  });

  test("a case that starts too much work is parked until someone retries", async () => {
    const { t, caseId } = await start();
    // The case has used up what one case may start.
    await t.run((ctx) =>
      limits.limit(ctx, "caseWorkPerCase", { key: caseId, count: 30 }),
    );
    let found = await send(t, caseId, { type: "goal.set", goal: "I moved" });
    expect(found).toMatchObject({
      status: "active",
      phase: "failed",
      run: { state: "failed", error: expect.stringMatching(/too much work/) },
    });
    // Later, a person looks and retries.
    vi.advanceTimersByTime(60 * 60 * 1000);
    found = await send(t, caseId, { type: "case.retry" });
    expect(found).toMatchObject({ waitingFor: "pack" });
  });
});

test("a partial packet records missing inputs and can be completed by editing the same case", async () => {
  try {
    const { t, caseId } = await start();
    await send(t, caseId, { type: "goal.set", goal: "Change my IRS address" });
    await send(t, caseId, { type: "pack.accept" });
    const partial = await send(t, caseId, { type: "artifact.prepare" });
    expect(partial.phase).toBe("review");
    expect(partial.artifact?.openItems).toHaveLength(3);
    const edited = await send(t, caseId, {
      type: "answers.set",
      key: "fullName",
      value: "Ada Example",
    });
    expect(edited.phase).toBe("answers");
    const complete = await answer(t, caseId, address);
    expect(complete.artifact?.revision).toBe(2);
    expect(complete.artifact?.openItems ?? []).toEqual([]);
  } finally {
    resetCases();
  }
});
