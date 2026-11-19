// The profile meeting cases: filled ahead, followed until approval, written
// back from answers, and offered back when it needs a look.
import type { FunctionArgs } from "convex/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { initConvexTest } from "../../setup.test";
import { read, resetCases, send, type T } from "../case/cases.testkit";

vi.mock("../../modelsForDemo", async () =>
  (await import("../case/cases.testkit")).mockModels(),
);
afterEach(resetCases);

const profile = api.easygov.profile.public;
const name = { given: "Ada", family: "Lovelace" };
const home = {
  street: "1 Old Road",
  city: "Oakland",
  state: "CA",
  postalCode: "94612",
  country: "US",
};

/** Saves a fact, and lets the person's open cases pick it up. */
async function save(t: T, args: FunctionArgs<typeof profile.save>) {
  await t.mutation(profile.save, args);
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

/** A fresh backend with the fixture packs, by fixture name. */
async function setup() {
  vi.useFakeTimers();
  const t = initConvexTest();
  const { packs } = await t.mutation(api.easygov.dev.seed, {});
  return { t, packs };
}

async function startOn(t: T, packId: Id<"processPacks">) {
  const caseId = await t.mutation(api.easygov.case.public.startCase, {
    packId,
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  return caseId;
}

describe("a profile filled in before the form is known", () => {
  test("answers what the pack reads, and offers what it points at", async () => {
    const { t, packs } = await setup();
    // No case and no pack yet: saving a fact needs neither.
    await save(t, { key: "name", value: name });
    await save(t, { key: "homeAddress", value: home });
    const caseId = await startOn(t, packs.irs8822);
    expect(await read(t, caseId)).toMatchObject({
      waitingFor: "answers",
      answers: { fullName: "Ada Lovelace" },
      fromProfile: ["fullName"],
      profileInputs: { fullName: "name" },
      // "Your old address" starts as today's home address, for a yes.
      suggestions: { oldAddress: "1 Old Road, Oakland, CA 94612" },
    });
  });

  test("a bad value is refused in words for the person", async () => {
    const { t } = await setup();
    await expect(
      t.mutation(profile.save, {
        key: "homeAddress",
        value: { ...home, state: "California" },
      }),
    ).rejects.toThrow(/two-letter state code/);
    await expect(
      t.mutation(profile.save, { key: "shoeSize", value: "9" }),
    ).rejects.toThrow(/isn't a profile fact/);
  });
});

describe("a case and the profile", () => {
  test("the case follows the profile until it's approved, then keeps its own", async () => {
    const { t, packs } = await setup();
    await save(t, { key: "name", value: name });
    const caseId = await startOn(t, packs.irs8822);
    // A correction to the profile reaches the open case.
    await save(t, {
      key: "name",
      value: { ...name, middle: "King" },
    });
    expect((await read(t, caseId)).answers.fullName).toBe("Ada King Lovelace");

    await send(t, caseId, {
      type: "answers.set",
      key: "oldAddress",
      value: "1 Old Road",
    });
    await send(t, caseId, {
      type: "answers.set",
      key: "newAddress",
      value: "2 New Street",
    });
    const done = await send(t, caseId, { type: "review.approve" });
    expect(done.status).toBe("done");
    // A later change is the person's, not this document's.
    await save(t, {
      key: "name",
      value: { given: "Ada", family: "Byron" },
    });
    expect((await read(t, caseId)).answers.fullName).toBe("Ada King Lovelace");
  });

  test("an answer kept to one case stops following, and leaves the profile alone", async () => {
    const { t, packs } = await setup();
    await save(t, { key: "name", value: name });
    const caseId = await startOn(t, packs.irs8822);
    const found = await send(t, caseId, {
      type: "answers.set",
      key: "fullName",
      value: "A. Lovelace",
      caseOnly: true,
    });
    expect(found).toMatchObject({
      answers: { fullName: "A. Lovelace" },
      fromProfile: [],
    });
    await save(t, {
      key: "name",
      value: { given: "Ada", family: "Byron" },
    });
    expect((await read(t, caseId)).answers.fullName).toBe("A. Lovelace");
    expect((await t.query(profile.get, {})).readings.fullName).toBe(
      "Ada Byron",
    );
  });
});

describe("what a person answers on a form", () => {
  test("a profile fact typed on a case is there for the next form", async () => {
    const { t, packs } = await setup();
    const first = await startOn(t, packs.irs8822);
    const answered = await send(t, first, {
      type: "answers.set",
      key: "fullName",
      value: "Ada Lovelace",
    });
    // Two words: no doubt which is the given name. The case now follows it.
    expect(answered.fromProfile).toEqual(["fullName"]);
    const next = await startOn(t, packs.ssaAppeal);
    expect((await read(t, next)).answers).toEqual({ fullName: "Ada Lovelace" });
  });

  test("a longer name stays on the case: its parts aren't ours to guess", async () => {
    const { t, packs } = await setup();
    const caseId = await startOn(t, packs.irs8822);
    await send(t, caseId, {
      type: "answers.set",
      key: "fullName",
      value: "Ada King Lovelace",
    });
    expect((await t.query(profile.get, {})).readings.fullName).toBeUndefined();
  });

  test("anything else is remembered, and offered when the same pack asks again", async () => {
    const { t, packs } = await setup();
    const first = await startOn(t, packs.ssaAppeal);
    await send(t, first, {
      type: "answers.set",
      key: "reasonForAppeal",
      value: "My records were overlooked.",
    });
    const again = await startOn(t, packs.ssaAppeal);
    expect((await read(t, again)).suggestions).toEqual({
      reasonForAppeal: "My records were overlooked.",
    });
    // Another pack doesn't get it for free.
    const other = await startOn(t, packs.irs8822);
    expect((await read(t, other)).suggestions).toEqual({});
  });
});

test("an old address is offered back, not filled in; a yes confirms it", async () => {
  const { t } = await setup();
  await save(t, { key: "name", value: name });
  await save(t, { key: "homeAddress", value: home });
  vi.setSystemTime(Date.now() + 400 * 24 * 60 * 60 * 1000);
  const saved = await t.run(async (ctx) => {
    const id = await ctx.db.insert("processPacks", {
      title: "Proof of residence letter",
      description: "A letter stating where you live.",
      aliases: [],
      jurisdiction: "us",
      forms: [],
      inputs: ["fullName", "homeCity"],
      status: "current",
      searchText: "proof of residence letter",
    });
    return id;
  });
  const caseId = await startOn(t, saved);
  // The name doesn't go off; the address is a year old.
  expect(await read(t, caseId)).toMatchObject({
    waitingFor: "answers",
    answers: { fullName: "Ada Lovelace" },
    suggestions: { homeCity: "Oakland" },
  });
  expect(
    (await t.query(profile.get, {})).facts.find((f) => f.key === "homeAddress"),
  ).toMatchObject({ stale: true });
  const accepted = await send(t, caseId, { type: "answers.accept" });
  expect(accepted).toMatchObject({
    answers: { homeCity: "Oakland" },
    fromProfile: ["fullName", "homeCity"],
  });
  expect(
    (await t.query(profile.get, {})).facts.find((f) => f.key === "homeAddress"),
  ).toMatchObject({ stale: false });
});

test("a finished change of address suggests the new home address", async () => {
  const { t, packs } = await setup();
  await save(t, { key: "name", value: name });
  await save(t, { key: "homeAddress", value: home });
  const caseId = await startOn(t, packs.irs8822);
  await send(t, caseId, { type: "answers.accept" });
  await send(t, caseId, {
    type: "answers.set",
    key: "newAddress",
    value: "2 New Street, Berkeley, CA 94704",
  });
  await send(t, caseId, { type: "review.approve" });
  const { proposals } = await t.query(profile.get, {});
  expect(proposals).toMatchObject([
    {
      fact: "homeAddress",
      label: "Home address",
      text: "2 New Street, Berkeley, CA 94704",
    },
  ]);
  // The profile isn't changed until the person confirms the parts.
  expect((await t.query(profile.get, {})).readings.homeCity).toBe("Oakland");
  await t.mutation(profile.settleProposal, {
    id: proposals[0].id,
    accept: true,
  });
  expect((await t.query(profile.get, {})).proposals).toEqual([]);
});

describe("what to ask before the form is known", () => {
  test("what most saved packs read, then exactly what the confirmed pack reads", async () => {
    const { t, packs } = await setup();
    // Every fixture pack reads the name; nothing else is read by any.
    expect(await t.query(profile.askAhead, {})).toEqual([
      { fact: "name", label: "Legal name", why: "likely" },
      { fact: "mailingAddress", label: "Mailing address", why: "likely" },
      { fact: "phone", label: "Phone number", why: "likely" },
    ]);
    const caseId = await startOn(t, packs.wageClaim);
    expect(await t.query(profile.askAhead, { caseId })).toEqual([
      { fact: "name", label: "Legal name", why: "needed" },
    ]);
    await save(t, { key: "name", value: name });
    expect(await t.query(profile.askAhead, { caseId })).toEqual([]);
  });
});

test("a guest's facts come along when the case is claimed", async () => {
  const { t, packs } = await setup();
  const guestKey = "g".repeat(40);
  await save(t, { key: "name", value: name, guestKey });
  const caseId = await t.mutation(api.easygov.case.public.startCase, {
    packId: packs.irs8822,
    guestKey,
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  // The account's own profile knows nothing yet.
  expect((await t.query(profile.get, {})).readings).toEqual({});
  await t.mutation(api.easygov.case.public.claimCase, { caseId, guestKey });
  expect((await t.query(profile.get, {})).readings.fullName).toBe(
    "Ada Lovelace",
  );
  expect((await read(t, caseId)).answers.fullName).toBe("Ada Lovelace");
});

test("forgetting removes what's kept apart from the cases", async () => {
  const { t, packs } = await setup();
  await save(t, { key: "name", value: name });
  const caseId = await startOn(t, packs.ssaAppeal);
  await send(t, caseId, {
    type: "answers.set",
    key: "reasonForAppeal",
    value: "x",
  });
  expect(await t.mutation(profile.forget, {})).toBe(false);
  expect((await t.query(profile.get, {})).readings).toEqual({});
  const again = await startOn(t, packs.ssaAppeal);
  expect(await read(t, again)).toMatchObject({ answers: {}, suggestions: {} });
  // The case that used them keeps what it was built from... until it's
  // open and re-read: an open case follows the profile.
  expect((await read(t, caseId)).answers.reasonForAppeal).toBe("x");
});
