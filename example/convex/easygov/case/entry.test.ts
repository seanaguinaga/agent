// Starting from a landing page: a case on a chosen pack, with files, a
// deadline, a letter, a referral the person agrees to, and no account.
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { initConvexTest } from "../../setup.test";
import { irs8822, wageClaim } from "../packs/packs.testkit";
import { addDays } from "../dates";
import { passes, renderLetter } from "./answers";
import { definitionOf } from "./schema";
import { answer, model, read, resetCases, send, type T } from "./cases.testkit";

vi.mock("../../modelsForDemo", async () =>
  (await import("./cases.testkit")).mockModels(),
);

const wages = {
  fullName: "Ada Lovelace",
  employer: "Analytical Engines Ltd",
  amountOwed: "6200",
  lastWorkDate: "2026-09-30",
};

async function savePack(t: T, pack: object, extra: object = {}) {
  const saved = await t.mutation(internal.easygov.packs.data.createPack, {
    ...wageClaim,
    ...pack,
    ...extra,
  });
  if (saved.kind !== "created") throw new Error("Could not save the pack");
  return saved.id;
}

/** A case started on the wage claim pack, as its landing page would. */
async function startOn(pack: object = {}, args: object = {}) {
  vi.useFakeTimers();
  const t = initConvexTest();
  const packId = await savePack(t, pack);
  const caseId = await t.mutation(api.easygov.case.public.createCase, {
    packId,
    ...args,
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  return { t, packId, caseId };
}

const upload = (t: T) =>
  t.run((ctx) => ctx.storage.store(new Blob(["final pay stub"])));

async function attach(t: T, caseId: Id<"cases">, key: string) {
  const storageId = await upload(t);
  return await send(t, caseId, { type: "evidence.add", key, storageId });
}

describe("starting on a pack", () => {
  afterEach(resetCases);

  test("skips the chat and the proposal, and makes no model call", async () => {
    model.failing = true;
    const { t, caseId } = await startOn({}, { source: "wage-claim-ca" });
    expect(await read(t, caseId)).toMatchObject({
      source: "wage-claim-ca",
      waitingFor: "answers",
      goal: { text: wageClaim.title },
      selection: { status: "accepted" },
    });
    // Nothing runs while the case waits for the answers.
    expect((await read(t, caseId)).run).toBeUndefined();
  });

  test("an old link starts the current version; a private pack starts nothing", async () => {
    vi.useFakeTimers();
    const t = initConvexTest();
    const first = await savePack(t, {});
    const second = await savePack(
      t,
      { inputs: [...wageClaim.inputs, "state"], forms: ["DLSE-1"] },
      { supersedes: first },
    );
    const caseId = await t.mutation(api.easygov.case.public.createCase, {
      packId: first,
    });
    expect(definitionOf((await read(t, caseId)).selection)?.id).toBe(second);

    const mine = await savePack(
      t,
      { title: "My own process", aliases: [], description: "Private" },
      { ownerId: "someone", reviewedPackIds: [second] },
    );
    await expect(
      t.mutation(api.easygov.case.public.createCase, { packId: mine }),
    ).rejects.toThrow(/not found/);
  });
});

describe("files, the deadline and the letter", () => {
  afterEach(resetCases);

  test("a required file is waited for, and a new one rebuilds the document", async () => {
    const { t, caseId } = await startOn();
    let found = await answer(t, caseId, wages);
    expect(found.waitingFor).toBe("answers");
    await expect(attach(t, caseId, "passport")).rejects.toThrow(
      /isn't one of this case's documents/,
    );

    found = await attach(t, caseId, "payStub");
    expect(found.waitingFor).toBe("review");
    const built = found.artifact!.fingerprint;

    // Another file in review: the document is rebuilt before it's accepted.
    found = await attach(t, caseId, "contract");
    expect(found.waitingFor).toBe("review");
    expect(found.artifact!.fingerprint).not.toBe(built);
  });

  test("the deadline is counted from an answer, which must be a date", async () => {
    const { t, caseId } = await startOn();
    expect((await read(t, caseId)).deadline).toBeNull();
    await expect(
      answer(t, caseId, { lastWorkDate: "last September" }),
    ).rejects.toThrow(/Use a date/);
    await expect(answer(t, caseId, { amountOwed: "a lot" })).rejects.toThrow(
      /Use a number/,
    );
    const found = await answer(t, caseId, { lastWorkDate: "2026-09-30" });
    expect(found.deadline).toEqual({
      label: "File a wage claim",
      date: "2029-09-29",
    });
  });

  test("the letter is written from the answers", async () => {
    const { t, caseId } = await startOn();
    await answer(t, caseId, wages);
    const found = await attach(t, caseId, "payStub");
    expect(found.artifact!.letter).toBe(
      "To Analytical Engines Ltd: I, Ada Lovelace, am owed $6200 in wages.",
    );
  });
});

describe("the referral", () => {
  afterEach(resetCases);

  async function accepted(amountOwed: string, args: object = {}) {
    const { t, caseId } = await startOn({}, args);
    await answer(t, caseId, { ...wages, amountOwed });
    await attach(t, caseId, "payStub");
    return {
      t,
      caseId,
      found: await send(t, caseId, { type: "artifact.accept" }),
    };
  }
  const referrals = (t: T) =>
    t.run((ctx) => ctx.db.query("referrals").collect());

  test("isn't offered when the pack's check doesn't pass", async () => {
    const { t, found } = await accepted("300");
    expect(found).toMatchObject({ status: "done", waitingFor: null });
    expect(found.referral).toBeUndefined();
    expect(await referrals(t)).toEqual([]);
  });

  test("shares exactly what was accepted, and only on a yes", async () => {
    const { t, caseId, found } = await accepted("6200", { source: "wages" });
    expect(found).toMatchObject({
      status: "active",
      waitingFor: "consent",
      referral: { kind: "employment", status: "offered" },
    });
    // Nothing more can change once it's accepted.
    await expect(answer(t, caseId, { amountOwed: "1" })).rejects.toThrow(
      /isn't expected/,
    );
    expect(await referrals(t)).toEqual([]);

    const shared = await send(t, caseId, { type: "referral.share" });
    expect(shared).toMatchObject({
      status: "done",
      referral: { status: "shared" },
    });
    expect(await referrals(t)).toMatchObject([
      {
        caseId,
        kind: "employment",
        source: "wages",
        goal: wageClaim.title,
        answers: wages,
        evidence: [{ key: "payStub", storageId: shared.evidence[0].storageId }],
        deadline: "2029-09-29",
        fingerprint: shared.accepted!.fingerprint,
      },
    ]);
  });

  test("declining ends the case with nothing shared", async () => {
    const { t, caseId } = await accepted("6200");
    const found = await send(t, caseId, { type: "referral.reject" });
    expect(found).toMatchObject({
      status: "done",
      referral: { status: "rejected" },
    });
    expect(await referrals(t)).toEqual([]);
  });
});

describe("a guest", () => {
  afterEach(resetCases);
  const guestKey = "a-secret-only-this-browser-knows-0001";

  test("reaches the case only with the key, and claims it before sharing", async () => {
    const { t, caseId } = await startOn({}, { guestKey });
    const {
      getCase,
      sendEvent: sendEvent,
      claimCase,
    } = api.easygov.case.public;
    await expect(t.query(getCase, { caseId })).rejects.toThrow(/not found/);
    await expect(
      t.query(getCase, { caseId, guestKey: `${guestKey}-wrong` }),
    ).rejects.toThrow(/not found/);
    await expect(
      t.mutation(api.easygov.case.public.createCase, { guestKey: "short" }),
    ).rejects.toThrow(/too short/);

    const guestSend = async (event: Parameters<typeof send>[2]) => {
      const { seq } = await t.query(getCase, { caseId, guestKey });
      await t.mutation(sendEvent, {
        caseId,
        event,
        expectedSeq: seq,
        guestKey,
      });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    };
    for (const [key, value] of Object.entries(wages)) {
      await guestSend({ type: "answers.set", key, value });
    }
    const storageId = await upload(t);
    await guestSend({ type: "evidence.add", key: "payStub", storageId });
    await guestSend({ type: "artifact.accept" });
    await expect(guestSend({ type: "referral.share" })).rejects.toThrow(
      /Create an account/,
    );

    await t.mutation(claimCase, { caseId, guestKey });
    await expect(t.query(getCase, { caseId, guestKey })).rejects.toThrow(
      /not found/,
    );
    const found = await send(t, caseId, { type: "referral.share" });
    expect(found).toMatchObject({ status: "done", userId: "test user" });
  });
});

describe("what a page reads", () => {
  afterEach(resetCases);
  const guestKey = "a-secret-only-this-browser-knows-0002";
  const { getCase, listCases, listHistory, listMessages } =
    api.easygov.case.public;
  const firstPage = { cursor: null, numItems: 10 };

  test("getCase says what to ask and which files, ready to render", async () => {
    const { t, caseId } = await startOn();
    await answer(t, caseId, { employer: wages.employer });
    const found = await read(t, caseId);
    expect(found.asks.map(({ key }) => key)).toEqual(
      expect.arrayContaining(Object.keys(wages)),
    );
    expect(found.asks.find(({ key }) => key === "employer")).toMatchObject({
      answer: wages.employer,
      following: false,
    });
    // The deadline is counted from this one, so it takes a date.
    expect(found.asks.find(({ key }) => key === "lastWorkDate")).toMatchObject({
      kind: "date",
      question: expect.any(String),
    });
    expect(found.files).toContainEqual(
      expect.objectContaining({ key: "payStub", attached: 0 }),
    );
    expect((await attach(t, caseId, "payStub")).files).toContainEqual(
      expect.objectContaining({ key: "payStub", attached: 1 }),
    );
    expect(found).toMatchObject({ guest: false, replying: false });
    expect(found).not.toHaveProperty("unmetered");
    expect(found).not.toHaveProperty("lastMessageKey");
  });

  test("a case's list, history and conversation are its owner's alone", async () => {
    const { t, caseId } = await startOn({}, { guestKey });
    const { threadId } = await t.query(getCase, { caseId, guestKey });

    const mine = await t.query(listCases, {
      paginationOpts: firstPage,
      guestKey,
    });
    expect(mine.page).toMatchObject([
      { id: caseId, phase: "answers", waitingFor: "answers" },
    ]);
    // The signed-in account has none: the guest's case isn't theirs.
    const theirs = await t.query(listCases, { paginationOpts: firstPage });
    expect(theirs.page).toEqual([]);

    const history = await t.query(listHistory, { caseId, guestKey });
    expect(history.map(({ kind }) => kind)).toContain("case.started");
    await expect(t.query(listHistory, { caseId })).rejects.toThrow(/not found/);

    const messages = { caseId, threadId, paginationOpts: firstPage };
    expect(
      (await t.query(listMessages, { ...messages, guestKey })).page,
    ).toEqual([]);
    await expect(t.query(listMessages, messages)).rejects.toThrow(/not found/);
    // The right key with someone else's thread is refused too.
    await expect(
      t.query(listMessages, { ...messages, guestKey, threadId: "another" }),
    ).rejects.toThrow(/not found/);
  });
});

describe("landing pages", () => {
  test("list the shared packs, and describe what one asks for", async () => {
    const t = initConvexTest();
    const packId = await savePack(t, {});
    await savePack(
      t,
      {
        ...irs8822,
        evidence: undefined,
        deadline: undefined,
        referral: undefined,
        output: undefined,
      },
      { ownerId: "someone", reviewedPackIds: [packId] },
    );
    const { page } = await t.query(api.easygov.packs.public.listLandings, {
      paginationOpts: { cursor: null, numItems: 10 },
    });
    expect(page).toMatchObject([{ id: packId, title: wageClaim.title }]);

    const landing = await t.query(api.easygov.packs.public.getLanding, {
      packId,
    });
    expect(landing).toMatchObject({
      id: packId,
      deadline: "File a wage claim",
      evidence: [{ key: "payStub", required: true }, { key: "contract" }],
    });
    expect(landing?.questions.map(({ key }) => key)).toEqual(wageClaim.inputs);
  });
});

describe("a pack's checks", () => {
  test("read an answer as text, a number, or a date", () => {
    const on = "2026-11-19";
    expect(passes({ input: "a", equals: "yes" }, { a: "yes" }, on)).toBe(true);
    expect(passes({ input: "a", equals: "yes" }, {}, on)).toBe(false);
    expect(passes({ input: "a", atLeast: 5000 }, { a: "5000" }, on)).toBe(true);
    expect(passes({ input: "a", atLeast: 5000 }, { a: "4999" }, on)).toBe(
      false,
    );
    expect(passes({ input: "a", atLeast: 0 }, { a: " " }, on)).toBe(false);
    const recent = { input: "a", withinDays: 60 };
    expect(passes(recent, { a: "2026-09-20" }, on)).toBe(true);
    expect(passes(recent, { a: "2026-09-19" }, on)).toBe(false);
    // Not yet happened, or not a date.
    expect(passes(recent, { a: "2026-11-20" }, on)).toBe(false);
    expect(passes(recent, { a: "2026-02-31" }, on)).toBe(false);
  });

  test("dates and letters", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("soon", 1)).toBeUndefined();
    expect(renderLetter("Dear {{who}}, {{missing}}.", { who: "Ada" })).toBe(
      "Dear Ada, .",
    );
  });

  test("a pack that names an input it doesn't have is refused", async () => {
    const t = initConvexTest();
    const save = (pack: object) =>
      t.mutation(internal.easygov.packs.data.createPack, {
        ...wageClaim,
        ...pack,
      });
    await expect(
      save({ deadline: { label: "File", fromInput: "nope", days: 30 } }),
    ).rejects.toThrow(/isn't an input/);
    await expect(
      save({ output: { ...wageClaim.output!, letter: "Dear {{nobody}}" } }),
    ).rejects.toThrow(/isn't an input/);
    await expect(
      save({
        evidence: [
          { key: "a", label: "A", required: true },
          { key: "a", label: "B", required: false },
        ],
      }),
    ).rejects.toThrow(/its own key/);
  });
});
