// Reaching a lawyer before the packet is done, and after a denial comes
// back: the person asks, the case goes as far as it has got, and a referral
// nobody takes is handed back.
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { initConvexTest } from "../../setup.test";
import { OPEN_DAYS } from "../firms/schema";
import { wageClaim } from "../packs/packs.testkit";
import {
  answer,
  model,
  read,
  resetCases,
  send,
  start,
  type T,
} from "./cases.testkit";

vi.mock("../../modelsForDemo", async () =>
  (await import("./cases.testkit")).mockModels(),
);

const wages = {
  fullName: "Ada Lovelace",
  employer: "Analytical Engines Ltd",
  amountOwed: "6200",
  lastWorkDate: "2026-09-30",
};
const cases = api.easygov.case.public;

/** A case started on the wage claim pack, as its landing page would. */
async function startOn(pack: object = {}, args: object = {}) {
  vi.useFakeTimers();
  const t = initConvexTest();
  const saved = await t.mutation(internal.easygov.packs.data.createPack, {
    ...wageClaim,
    ...pack,
  });
  if (saved.kind !== "created") throw new Error("Could not save the pack");
  const caseId = await t.mutation(cases.createCase, {
    packId: saved.id,
    ...args,
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  return { t, caseId };
}

const referrals = (t: T) => t.run((ctx) => ctx.db.query("referrals").collect());

async function attach(
  t: T,
  caseId: Id<"cases">,
  file: { key?: string; name?: string; type?: string } = {},
) {
  const { type, ...rest } = file;
  const storageId = await t.run((ctx) =>
    ctx.storage.store(new Blob(["a letter"], { type })),
  );
  return await send(t, caseId, { type: "evidence.add", storageId, ...rest });
}

describe("asking for a lawyer early", () => {
  afterEach(resetCases);

  test("shares the case as far as it has got, and the person carries on", async () => {
    const { t, caseId } = await startOn();
    await answer(t, caseId, { amountOwed: wages.amountOwed });
    // The pack is one lawyers take, so the page can suggest it.
    expect((await read(t, caseId)).lawyer).toEqual({
      available: true,
      reason: "contested",
    });

    const asked = await send(t, caseId, { type: "referral.request" });
    expect(asked).toMatchObject({
      phase: "answers",
      referral: { kind: "employment", status: "shared" },
      lawyer: { available: false },
    });
    expect(await referrals(t)).toMatchObject([
      {
        status: "open",
        kind: "employment",
        stage: "answers",
        amountBand: "$5,000 to $25,000",
        jurisdiction: "us/ca",
        answers: { amountOwed: wages.amountOwed },
        evidence: [],
      },
    ]);
    expect((await referrals(t))[0].artifact).toBeUndefined();
    await expect(send(t, caseId, { type: "referral.request" })).rejects.toThrow(
      /already with a lawyer/,
    );

    // Finishing the packet doesn't ask again, or share twice.
    await answer(t, caseId, wages);
    await attach(t, caseId, { key: "payStub" });
    const done = await send(t, caseId, { type: "artifact.accept" });
    expect(done).toMatchObject({
      status: "done",
      referral: { kind: "employment", status: "shared" },
    });
    expect(await referrals(t)).toHaveLength(1);
  });

  test("works from the proposed process, and survives accepting it", async () => {
    const { t, caseId } = await start();
    await expect(send(t, caseId, { type: "referral.request" })).rejects.toThrow(
      /isn't expected/,
    );
    const proposed = await send(t, caseId, {
      type: "goal.set",
      goal: "I moved and need to tell the IRS",
    });
    // A change of address isn't contested: offered, not suggested.
    expect(proposed).toMatchObject({
      waitingFor: "pack",
      lawyer: { available: true },
    });
    expect(proposed.lawyer.reason).toBeUndefined();

    await send(t, caseId, { type: "referral.request" });
    expect(await referrals(t)).toMatchObject([
      { kind: "advice", stage: "plan", jurisdiction: "us" },
    ]);
    const accepted = await send(t, caseId, { type: "pack.accept" });
    expect(accepted.referral).toEqual({ kind: "advice", status: "shared" });
  });

  test("a guest claims the case first", async () => {
    const guestKey = "a-secret-only-this-browser-knows-0003";
    const { t, caseId } = await startOn({}, { guestKey });
    const { seq } = await t.query(cases.getCase, { caseId, guestKey });
    await expect(
      t.mutation(cases.sendEvent, {
        caseId,
        guestKey,
        expectedSeq: seq,
        event: { type: "referral.request" },
      }),
    ).rejects.toThrow(/Create an account/);
    expect(await referrals(t)).toEqual([]);
  });
});

describe("a pack's referral check", () => {
  afterEach(resetCases);

  test("passes on any one of several answers", async () => {
    // Too little is owed, but the job ended recently enough to matter.
    const { t, caseId } = await startOn({
      referral: {
        kind: "employment",
        when: { input: "amountOwed", atLeast: 5000 },
        orWhen: [{ input: "lastWorkDate", withinDays: 100000 }],
      },
    });
    await answer(t, caseId, { ...wages, amountOwed: "100" });
    await attach(t, caseId, { key: "payStub" });
    const found = await send(t, caseId, { type: "artifact.accept" });
    expect(found).toMatchObject({
      waitingFor: "consent",
      referral: { kind: "employment", status: "offered" },
    });
    // Both answers are checked for what they must be.
    await expect(
      t.mutation(internal.easygov.packs.data.createPack, {
        ...wageClaim,
        title: "Another wage letter",
        referral: {
          kind: "employment",
          orWhen: [{ input: "notAnInput", equals: "yes" }],
        },
      }),
    ).rejects.toThrow(/isn't an input/);
  });
});

describe("after a decision comes back", () => {
  afterEach(resetCases);

  /** A finished case that owed too little for a referral to be offered. */
  async function done() {
    const { t, caseId } = await startOn();
    await answer(t, caseId, { ...wages, amountOwed: "100" });
    await attach(t, caseId, { key: "payStub" });
    const found = await send(t, caseId, { type: "artifact.accept" });
    expect(found).toMatchObject({ status: "done" });
    expect(found.referral).toBeUndefined();
    return { t, caseId };
  }

  test("a denial suggests a lawyer, and goes with the case when asked", async () => {
    const { t, caseId } = await done();
    model.replies.push(
      JSON.stringify({
        what: "A letter from the employer refusing to pay, dated 2026-11-02.",
        stated: [],
        answers: [],
        adverse: true,
      }),
    );
    const denied = await attach(t, caseId, {
      name: "refusal.txt",
      type: "text/plain",
    });
    expect(denied.evidence[1]).toMatchObject({
      followUp: true,
      read: { status: "read", adverse: true },
    });
    expect(denied.lawyer).toEqual({ available: true, reason: "decision" });

    const asked = await send(t, caseId, { type: "referral.request" });
    expect(asked).toMatchObject({
      status: "done",
      referral: { kind: "employment", status: "shared" },
    });
    // The refusal goes too: it's why the person is asking.
    const [shared] = await referrals(t);
    expect(shared).toMatchObject({ stage: "decision" });
    expect(shared.evidence.map(({ name }) => name)).toEqual([
      "payStub",
      "refusal.txt",
    ]);
  });

  test("a receipt doesn't", async () => {
    const { t, caseId } = await done();
    model.replies.push(
      JSON.stringify({ what: "A receipt.", stated: [], answers: [] }),
    );
    const found = await attach(t, caseId, {
      name: "receipt.txt",
      type: "text/plain",
    });
    // Still the contested process it always was: no decision against them.
    expect(found.lawyer).toEqual({ available: true, reason: "contested" });
  });
});

describe("a referral nobody takes", () => {
  afterEach(resetCases);

  test("expires, tells the person, and can be asked for again", async () => {
    const { t, caseId } = await startOn();
    await send(t, caseId, { type: "referral.request" });
    const expire = () =>
      t.mutation(internal.easygov.firms.data.expireReferrals, {});
    // Not yet: firms still have time.
    expect(await expire()).toBe(0);

    vi.setSystemTime(Date.now() + (OPEN_DAYS + 1) * 24 * 60 * 60 * 1000);
    expect(await expire()).toBe(1);
    expect(await expire()).toBe(0);
    const found = await read(t, caseId);
    expect(found).toMatchObject({
      referral: { kind: "employment", status: "expired" },
      lawyer: { available: true },
    });
    const history = await t.query(cases.listHistory, { caseId });
    expect(history.map(({ kind }) => kind)).toContain("referral.expired");
    expect(await t.query(cases.handoff, { caseId })).toMatchObject({
      status: "expired",
    });

    // Asking again makes a new referral, and that's the one taken back.
    await send(t, caseId, { type: "referral.request" });
    expect((await referrals(t)).map(({ status }) => status)).toEqual([
      "expired",
      "open",
    ]);
    expect(await t.mutation(cases.withdrawReferral, { caseId })).toBe(true);
    expect((await referrals(t)).map(({ status }) => status)).toEqual([
      "expired",
      "withdrawn",
    ]);
  });
});
