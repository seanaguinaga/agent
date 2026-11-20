// The firm side: a shared case is previewed without the person's details,
// taken by one firm, and read only by that firm.
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { initConvexTest } from "../../setup.test";
import {
  answer,
  model,
  read,
  resetCases,
  send,
  start,
  type T,
} from "../case/cases.testkit";
import { request, wageClaim } from "../packs/packs.testkit";
import { covers } from "./schema";

vi.mock("../../modelsForDemo", async () =>
  (await import("../case/cases.testkit")).mockModels(),
);

const wages = {
  fullName: "Ada Lovelace",
  employer: "Analytical Engines Ltd",
  amountOwed: "6200",
  lastWorkDate: "2026-09-30",
};
const firms = api.easygov.firms.public;

/** A reviewed firm. The signed-in account ("test user") acts for it. */
const saveFirm = (t: T, firm: object = {}) =>
  t.mutation(internal.easygov.firms.data.save, {
    name: "Babbage & Co",
    userId: "test user",
    coverage: [{ kind: "employment", jurisdiction: "us/ca" }],
    ...firm,
  });

/** A wage claim case, approved and shared with a lawyer. */
async function shared(pack: object = {}) {
  vi.useFakeTimers();
  const t = initConvexTest();
  const saved = await t.mutation(internal.easygov.packs.data.save, {
    ...wageClaim,
    ...pack,
  });
  if (saved.kind !== "created") throw new Error("Could not save the pack");
  const caseId = await t.mutation(api.easygov.case.public.startCase, {
    packId: saved.id,
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  await answer(t, caseId, wages);
  const storageId = await t.run((ctx) =>
    ctx.storage.store(new Blob(["final pay stub"])),
  );
  await send(t, caseId, {
    type: "document.attach",
    key: "payStub",
    storageId,
  });
  await send(t, caseId, { type: "review.approve" });
  await send(t, caseId, { type: "referral.share" });
  return { t, caseId };
}

const previews = (t: T, firmId: Id<"firms">) =>
  t.query(firms.previews, { firmId });

describe("previews", () => {
  afterEach(resetCases);

  test("show what a referral is about, and nothing the person wrote", async () => {
    const { t } = await shared();
    const firmId = await saveFirm(t);
    const found = await previews(t, firmId);
    expect(found).toEqual([
      {
        id: expect.any(String),
        kind: "employment",
        jurisdiction: "us/ca",
        process: wageClaim.title,
        deadline: "2029-09-29",
        answered: ["amountOwed", "employer", "fullName", "lastWorkDate"],
        attached: ["payStub"],
        files: 1,
        priceCents: 5000,
      },
    ]);
    const text = JSON.stringify(found);
    for (const value of Object.values(wages)) expect(text).not.toContain(value);
  });

  test("go only to firms that cover the kind and the place", async () => {
    const { t } = await shared({ jurisdiction: "us/ca/alameda" });
    const state = await saveFirm(t);
    const federal = await saveFirm(t, {
      coverage: [{ kind: "employment", jurisdiction: "us" }],
    });
    const elsewhere = await saveFirm(t, {
      coverage: [{ kind: "employment", jurisdiction: "us/ny" }],
    });
    const otherKind = await saveFirm(t, {
      coverage: [{ kind: "immigration", jurisdiction: "us/ca" }],
    });
    expect(await previews(t, state)).toHaveLength(1);
    expect(await previews(t, federal)).toHaveLength(1);
    expect(await previews(t, elsewhere)).toEqual([]);
    expect(await previews(t, otherKind)).toEqual([]);
  });

  test("a place is covered by itself and the places containing it", () => {
    const coverage = [{ kind: "employment", jurisdiction: "us/ca" }];
    const at = (jurisdiction?: string) =>
      covers(coverage, { kind: "employment", jurisdiction });
    expect(at("us/ca")).toBe(true);
    expect(at("us/ca/alameda")).toBe(true);
    expect(at("us")).toBe(false);
    // Sorts next to "us/ca", but it's another place.
    expect(at("us/ca-x")).toBe(false);
    expect(at(undefined)).toBe(false);
  });
});

describe("accepting", () => {
  afterEach(resetCases);

  test("the first firm gets the case, owes its price, and alone can read it", async () => {
    const { t, caseId } = await shared({
      referral: { ...wageClaim.referral!, priceCents: 12000 },
    });
    const first = await saveFirm(t);
    const second = await saveFirm(t, { name: "Second & Sons" });
    const [{ id: referralId }] = await previews(t, first);

    // Nothing to read before accepting.
    await expect(
      t.query(firms.packet, { firmId: first, referralId }),
    ).rejects.toThrow(/not found/);

    await t.mutation(firms.accept, { firmId: first, referralId });
    await expect(
      t.mutation(firms.accept, { firmId: second, referralId }),
    ).rejects.toThrow(/no longer available/);
    expect(await previews(t, second)).toEqual([]);
    await expect(
      t.query(firms.packet, { firmId: second, referralId }),
    ).rejects.toThrow(/not found/);

    const packet = await t.query(firms.packet, { firmId: first, referralId });
    expect(packet).toMatchObject({
      kind: "employment",
      userId: "test user",
      goal: wageClaim.title,
      deadline: "2029-09-29",
      answers: wages,
      files: [{ key: "payStub", name: "payStub", url: expect.any(String) }],
    });
    expect(await t.query(firms.accepted, { firmId: first })).toMatchObject([
      { id: referralId, priceCents: 12000 },
    ]);
    const charges = await t.run((ctx) =>
      ctx.db.query("referralCharges").collect(),
    );
    expect(charges).toMatchObject([
      { firmId: first, referralId, amountCents: 12000, status: "owed" },
    ]);
    const history = await t.run((ctx) =>
      ctx.db
        .query("caseEvents")
        .withIndex("by_caseId", (q) => q.eq("caseId", caseId))
        .collect(),
    );
    expect(history.at(-1)).toMatchObject({
      kind: "referral.accepted",
      detail: "Babbage & Co",
    });
  });

  test("a firm that passes isn't shown the referral again", async () => {
    const { t } = await shared();
    const firmId = await saveFirm(t);
    const other = await saveFirm(t, { name: "Second & Sons" });
    const [{ id: referralId }] = await previews(t, firmId);
    await t.mutation(firms.decline, { firmId, referralId });
    await t.mutation(firms.decline, { firmId, referralId });
    expect(await previews(t, firmId)).toEqual([]);
    expect(await previews(t, other)).toHaveLength(1);
  });

  test("a firm that passed on many still sees the ones after them", async () => {
    const { t } = await shared();
    const firmId = await saveFirm(t);
    const [{ id: first }] = await previews(t, firmId);
    // Fifty it passed on, then one it hasn't seen.
    const unseen = await t.run(async (ctx) => {
      const { _id, _creationTime, ...referral } = (await ctx.db.get(
        "referrals",
        first,
      ))!;
      let referralId = first;
      for (let i = 0; i < 50; i++) {
        await ctx.db.insert("referralDeclines", { firmId, referralId });
        referralId = await ctx.db.insert("referrals", referral);
      }
      return referralId;
    });
    const found = await previews(t, firmId);
    expect(found.map(({ id }) => id)).toEqual([unseen]);
  });

  test("a firm that passed can still accept, and a taken referral can't be passed on", async () => {
    const { t } = await shared();
    const firmId = await saveFirm(t);
    const other = await saveFirm(t, { name: "Second & Sons" });
    const [{ id: referralId }] = await previews(t, firmId);
    await t.mutation(firms.decline, { firmId, referralId });
    await t.mutation(firms.accept, { firmId, referralId });
    // Accepting undoes the pass: the firm isn't on record as both.
    expect(
      await t.run((ctx) => ctx.db.query("referralDeclines").collect()),
    ).toEqual([]);
    for (const firm of [firmId, other]) {
      await expect(
        t.mutation(firms.decline, { firmId: firm, referralId }),
      ).rejects.toThrow(/no longer available/);
    }
  });

  test("only the firm's account acts for it, and only on what it covers", async () => {
    const { t } = await shared();
    const mine = await saveFirm(t);
    const theirs = await saveFirm(t, { userId: "someone else" });
    const [{ id: referralId }] = await previews(t, mine);
    await expect(previews(t, theirs)).rejects.toThrow(/Firm not found/);
    await expect(
      t.mutation(firms.accept, { firmId: theirs, referralId }),
    ).rejects.toThrow(/Firm not found/);

    const elsewhere = await saveFirm(t, {
      coverage: [{ kind: "employment", jurisdiction: "us/ny" }],
    });
    await expect(
      t.mutation(firms.accept, { firmId: elsewhere, referralId }),
    ).rejects.toThrow(/Referral not found/);
  });
});

describe("the person", () => {
  afterEach(resetCases);

  test("can take a shared case back until a firm accepts it", async () => {
    const { t, caseId } = await shared();
    const firmId = await saveFirm(t);
    const [{ id: referralId }] = await previews(t, firmId);
    const { withdrawReferral } = api.easygov.case.public;
    expect(await t.mutation(withdrawReferral, { caseId })).toBe(true);
    // The case says so too, not only the referral.
    expect((await read(t, caseId)).referral).toEqual({
      kind: "employment",
      status: "withdrawn",
    });
    expect(await previews(t, firmId)).toEqual([]);
    await expect(
      t.mutation(firms.accept, { firmId, referralId }),
    ).rejects.toThrow(/no longer available/);
    await expect(
      t.mutation(firms.decline, { firmId, referralId }),
    ).rejects.toThrow(/no longer available/);
    expect(await t.mutation(withdrawReferral, { caseId })).toBe(false);
  });

  test("can't take it back once a firm has it", async () => {
    const { t, caseId } = await shared();
    const firmId = await saveFirm(t);
    const [{ id: referralId }] = await previews(t, firmId);
    await t.mutation(firms.accept, { firmId, referralId });
    expect(
      await t.mutation(api.easygov.case.public.withdrawReferral, { caseId }),
    ).toBe(false);
  });

  test("a request for advice is matched by the place the request named", async () => {
    const { t, caseId } = await start();
    model.replies.push(
      request({
        kind: "referral",
        jurisdiction: "us/ca",
        message: "I'll connect you with legal help.",
      }),
    );
    await send(t, caseId, {
      type: "goal.set",
      goal: "Should I sue my former employer?",
    });
    await send(t, caseId, { type: "processPack.confirm" });
    await send(t, caseId, { type: "referral.share" });
    const firmId = await saveFirm(t, {
      coverage: [{ kind: "advice", jurisdiction: "us/ca" }],
    });
    expect(await previews(t, firmId)).toMatchObject([
      {
        kind: "advice",
        jurisdiction: "us/ca",
        answered: [],
        attached: [],
        files: 0,
      },
    ]);
    // The goal is the person's own words: it isn't in the preview.
    expect(JSON.stringify(await previews(t, firmId))).not.toContain("sue");
  });
});

describe("saving a firm", () => {
  test("needs a name, an account and real places", async () => {
    const t = initConvexTest();
    await expect(saveFirm(t, { name: " " })).rejects.toThrow(/name/);
    await expect(saveFirm(t, { coverage: [] })).rejects.toThrow(/1 to 20/);
    await expect(
      saveFirm(t, {
        coverage: [{ kind: "employment", jurisdiction: "California" }],
      }),
    ).rejects.toThrow(/jurisdiction path/);
    const firmId = await saveFirm(t);
    await saveFirm(t, {
      firmId,
      coverage: [{ kind: "employment", jurisdiction: "US/NY" }],
    });
    const firm = await t.run((ctx) => ctx.db.get("firms", firmId));
    expect(firm?.coverage).toEqual([
      { kind: "employment", jurisdiction: "us/ny" },
    ]);
  });
});
