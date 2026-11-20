// A case's evidence: the letter that starts it, the evidence behind it, what
// reading them finds, and what comes back once the case is done.
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../../_generated/api";
import { initConvexTest } from "../../setup.test";
import { wageClaim } from "../packs/packs.testkit";
import {
  answer,
  model,
  read,
  resetCases,
  send,
  start,
  texts,
  type T,
} from "./cases.testkit";
import { MAX_EVIDENCE } from "./evidence";

vi.mock("../../modelsForDemo", async () =>
  (await import("./cases.testkit")).mockModels(),
);

const wages = {
  fullName: "Ada Lovelace",
  employer: "Analytical Engines Ltd",
  amountOwed: "6200",
  lastWorkDate: "2026-09-30",
};

/** A case started on the wage claim pack, as its landing page would. */
async function startOn() {
  vi.useFakeTimers();
  const t = initConvexTest();
  const saved = await t.mutation(internal.easygov.packs.data.save, wageClaim);
  if (saved.kind !== "created") throw new Error("Could not save the pack");
  const caseId = await t.mutation(api.easygov.case.public.startCase, {
    packId: saved.id,
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  return { t, caseId };
}

/** Uploads a file. Text is read by the model; a file with no type isn't. */
const upload = (t: T, type?: string) =>
  t.run((ctx) => ctx.storage.store(new Blob(["Final pay: $6200"], { type })));

async function attach(
  t: T,
  caseId: Parameters<typeof read>[1],
  file: { key?: string; name?: string; type?: string } = {},
) {
  const { type, ...rest } = file;
  const storageId = await upload(t, type);
  const found = await send(t, caseId, {
    type: "evidence.add",
    storageId,
    ...rest,
  });
  return { found, storageId };
}

const reading = (summary: string, answers: Record<string, string> = {}) =>
  JSON.stringify({
    summary,
    answers: Object.entries(answers).map(([key, value]) => ({ key, value })),
  });

describe("attaching", () => {
  afterEach(resetCases);

  test("several files per document, other evidence, and what each is", async () => {
    const { t, caseId } = await startOn();
    await answer(t, caseId, wages);
    // Other evidence doesn't stand in for the file the pack requires.
    const other = await attach(t, caseId, { name: "texts.png" });
    expect(other.found.waitingFor).toBe("answers");
    expect(other.found.evidence).toMatchObject([
      {
        name: "texts.png",
        mediaType: "application/octet-stream",
        size: 16,
        read: { status: "unread" },
      },
    ]);
    expect(other.found.evidenceUrls[other.storageId]).toEqual(
      expect.any(String),
    );

    // Labelled, the same file becomes that document.
    let found = await send(t, caseId, {
      type: "evidence.update",
      storageId: other.storageId,
      key: "payStub",
    });
    expect(found.evidence).toMatchObject([
      { name: "texts.png", key: "payStub" },
    ]);
    expect(found.waitingFor).toBe("review");

    // A second page of the same document sits beside the first.
    ({ found } = await attach(t, caseId, { key: "payStub", name: "page 2" }));
    expect(found.evidence.map(({ key }) => key)).toEqual([
      "payStub",
      "payStub",
    ]);
  });

  test("removing the only required file sends the case back for it", async () => {
    const { t, caseId } = await startOn();
    await answer(t, caseId, wages);
    const { found, storageId } = await attach(t, caseId, { key: "payStub" });
    expect(found.waitingFor).toBe("review");
    const removed = await send(t, caseId, {
      type: "evidence.remove",
      storageId,
    });
    expect(removed).toMatchObject({ evidence: [], waitingFor: "answers" });
    expect(await t.run((ctx) => ctx.storage.get(storageId))).toBeNull();
    await expect(
      send(t, caseId, { type: "evidence.remove", storageId }),
    ).rejects.toThrow(/isn't attached/);
  });

  test("a case holds a bounded number of files", async () => {
    const { t, caseId } = await startOn();
    for (let i = 0; i < MAX_EVIDENCE; i++) await attach(t, caseId);
    await expect(attach(t, caseId)).rejects.toThrow(/up to 30 files/);
  });
});

describe("reading", () => {
  afterEach(resetCases);

  test("what a file states is offered as answers, never filled in", async () => {
    const { t, caseId } = await startOn();
    model.replies.push(
      reading("A pay stub from Analytical Engines Ltd.", {
        employer: "Analytical Engines Ltd",
        // Not a date, and not a question the pack asks: both dropped.
        lastWorkDate: "last September",
        salary: "100",
      }),
    );
    const { found } = await attach(t, caseId, {
      key: "payStub",
      name: "stub.txt",
      type: "text/plain",
    });
    expect(found.evidence[0].read).toEqual({
      status: "read",
      summary: "A pay stub from Analytical Engines Ltd.",
      answers: { employer: "Analytical Engines Ltd" },
    });
    expect(found.answers.employer).toBeUndefined();
    expect(found.suggestions).toMatchObject({
      employer: "Analytical Engines Ltd",
    });
    const accepted = await send(t, caseId, { type: "answers.accept" });
    expect(accepted.answers.employer).toBe("Analytical Engines Ltd");
  });

  test("a file that can't be read is kept, with the reason", async () => {
    const { t, caseId } = await startOn();
    model.failing = true;
    const { found } = await attach(t, caseId, {
      key: "payStub",
      type: "text/plain",
    });
    expect(found.evidence[0].read).toEqual({
      status: "unread",
      reason: "It couldn't be read.",
    });
    expect(found.suggestions).toEqual({});
  });

  test("a case can start from the letter alone", async () => {
    const { t, caseId } = await start();
    model.replies.push(
      reading("A notice from the IRS dated 2026-10-01 about my address."),
      '{"reply":"Got it.","goal":"Tell the IRS my new address"}',
    );
    const { found } = await attach(t, caseId, {
      name: "notice.txt",
      type: "text/plain",
    });
    expect(found).toMatchObject({
      goal: { text: "Tell the IRS my new address" },
      waitingFor: "pack",
    });
    expect((await texts(t, caseId)).slice(0, 2)).toEqual([
      [
        "user",
        'I attached "notice.txt". It says: A notice from the IRS dated 2026-10-01 about my address.',
      ],
      ["assistant", "Got it."],
    ]);
  });
});

describe("after filing", () => {
  afterEach(resetCases);

  async function done() {
    const { t, caseId } = await startOn();
    await answer(t, caseId, { ...wages, amountOwed: "100" });
    await attach(t, caseId, { key: "payStub" });
    const found = await send(t, caseId, { type: "artifact.accept" });
    expect(found.status).toBe("done");
    return { t, caseId, accepted: found.accepted!.fingerprint };
  }

  test("a done case takes what came back, apart from what was accepted", async () => {
    const { t, caseId } = await done();
    model.replies.push(reading("A receipt dated 2026-11-02."));
    const { found, storageId } = await attach(t, caseId, {
      name: "receipt.txt",
      type: "text/plain",
    });
    expect(found.status).toBe("done");
    expect(found.evidence[1]).toMatchObject({
      name: "receipt.txt",
      followUp: true,
      read: { status: "read", summary: "A receipt dated 2026-11-02." },
    });
    // It isn't one of the pack's documents, and the case's own files stay.
    await expect(attach(t, caseId, { key: "payStub" })).rejects.toThrow(
      /without a key/,
    );
    await expect(
      send(t, caseId, {
        type: "evidence.remove",
        storageId: found.evidence[0].storageId,
      }),
    ).rejects.toThrow(/isn't attached/);
    const removed = await send(t, caseId, {
      type: "evidence.remove",
      storageId,
    });
    expect(removed.evidence).toHaveLength(1);
  });

  test("a canceled case takes nothing", async () => {
    const { t, caseId } = await startOn();
    await send(t, caseId, { type: "case.cancel" });
    await expect(attach(t, caseId)).rejects.toThrow(/canceled/);
  });
});
