import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../../_generated/api";
import {
  answer,
  chat,
  model,
  read,
  resetCases,
  send,
  start,
  type T,
} from "../case/cases.testkit";
import { choose, request } from "./packs.testkit";
import {
  jurisdictionChain,
  normalizeFormId,
  parseJurisdiction,
} from "./schema";

vi.mock("../../modelsForDemo", async () =>
  (await import("../case/cases.testkit")).mockModels(),
);

afterEach(resetCases);

const processPacks = internal.easygov.packs.data;
const renewal = {
  title: "California driver's license renewal",
  description: "Prepare a renewal checklist for a noncommercial license.",
  aliases: ["extend driving permit", "DL renewal"],
  jurisdiction: "us/ca",
  authority: "Department of Motor Vehicles",
  forms: [],
  inputs: ["expirationDate"],
};

// The pack the live run drafted, and the draft the model writes for it.
const garnishment = {
  title: "California Wage Garnishment Notice Review",
  description:
    "Preparation checklist for understanding a wage garnishment notice.",
  aliases: ["wage withholding notice"],
  jurisdiction: "us/ca",
  authority: "California state court",
  forms: [],
  inputs: ["noticeDate"],
};
const recipe = {
  title: garnishment.title,
  description: garnishment.description,
  aliases: garnishment.aliases,
  inputQuestions: [
    { key: "noticeDate", question: "What date is on the notice?" },
  ],
  output: {
    title: "Notice review preparation",
    checklist: ["Confirm the court and case number on the notice."],
  },
};

async function owner(t: T, caseId: Parameters<typeof read>[1]) {
  return (await read(t, caseId)).userId;
}

async function ownPacks(t: T, ownerId: string) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("processPacks").collect()).filter(
      (p) => p.ownerId === ownerId,
    ),
  );
}

describe("jurisdictions and forms", () => {
  test("a jurisdiction is a country code, then narrower places", () => {
    expect(parseJurisdiction(" US/CA/Alameda ")).toBe("us/ca/alameda");
    expect(parseJurisdiction("us")).toBe("us");
    expect(parseJurisdiction("california")).toBeNull();
    expect(parseJurisdiction("us/ca/alameda/oakland/x")).toBeNull();
    expect(parseJurisdiction("")).toBeNull();
    expect(jurisdictionChain("us/ca/alameda")).toEqual([
      "us/ca/alameda",
      "us/ca",
      "us",
    ]);
  });

  test("form numbers are normalized", () => {
    expect(normalizeFormId("Form IRS 8822")).toBe("IRS-8822");
    expect(normalizeFormId("irs-8822")).toBe("IRS-8822");
  });
});

describe("finding packs", () => {
  test("a request finds packs from its jurisdiction outward, that the case may see", async () => {
    const { t, caseId } = await start();
    const ownerId = await owner(t, caseId);
    const saved = await t.mutation(processPacks.save, { ownerId, ...renewal });
    if (saved.kind !== "created") throw new Error("Expected a new pack");
    await t.mutation(processPacks.save, {
      ...renewal,
      ownerId: "another owner",
    });
    await t.mutation(processPacks.save, {
      ...renewal,
      ownerId,
      jurisdiction: "us/nv",
      title: "Nevada driver's license renewal",
    });
    const found = await t.query(processPacks.findMatch, {
      caseId,
      jurisdiction: "us/ca/alameda",
      terms: "driver license renewal",
    });
    expect(found.map(({ id }) => id)).toEqual([saved.id]);
  });

  test("a federal pack is found from a state request", async () => {
    const { t, caseId } = await start();
    const found = await t.query(processPacks.findMatch, {
      caseId,
      jurisdiction: "us/ca",
      terms: "IRS-8822 address",
    });
    expect(found).toMatchObject([
      { title: "IRS change of address (Form 8822)" },
    ]);
  });

  test("an authority named differently still finds the pack (live run)", async () => {
    const { t, caseId } = await start();
    const ownerId = await owner(t, caseId);
    const saved = await t.mutation(processPacks.save, {
      ownerId,
      ...garnishment,
    });
    if (saved.kind !== "created") throw new Error("Expected a saved pack");
    // The live run's second wording: "courts" and "understand-notice".
    expect(
      await t.query(processPacks.findMatch, {
        caseId,
        jurisdiction: "us/ca",
        terms: "courts wage garnishment understand notice",
      }),
    ).toMatchObject([{ id: saved.id }]);
    expect(
      await t.mutation(processPacks.save, {
        ownerId,
        ...garnishment,
        authority: "Courts",
        title: "Understand a wage garnishment notice",
      }),
    ).toMatchObject({ kind: "reviewDuplicates", packs: [{ id: saved.id }] });
  });
});

describe("saving packs", () => {
  test("a similar pack needs review, then saves", async () => {
    const { t, caseId } = await start();
    const ownerId = await owner(t, caseId);
    const results = await Promise.all([
      t.mutation(processPacks.save, { ownerId, ...renewal }),
      t.mutation(processPacks.save, { ownerId, ...renewal }),
    ]);
    const created = results.find(({ kind }) => kind === "created");
    if (created?.kind !== "created") throw new Error("Expected a new pack");
    expect(results).toContainEqual({
      kind: "reviewDuplicates",
      packs: [expect.objectContaining({ id: created.id })],
    });
    expect(
      await t.mutation(processPacks.save, {
        ownerId,
        ...renewal,
        title: "Replace a lost driver's license",
        description: "Prepare a replacement checklist for a lost license.",
        aliases: [],
        reviewedPackIds: [created.id],
      }),
    ).toMatchObject({ kind: "created" });
  });

  test("a new version replaces the old one, and pinned cases keep theirs", async () => {
    const { t, caseId } = await start();
    const ownerId = await owner(t, caseId);
    const v1 = await t.mutation(processPacks.save, { ownerId, ...renewal });
    if (v1.kind !== "created") throw new Error("Expected a new pack");
    model.replies.push(
      request({ jurisdiction: "us/ca", searchTerms: "renew driver license" }),
      choose(1),
    );
    await send(t, caseId, { type: "intake.submit", goal: "Renew my CA DL" });
    await send(t, caseId, { type: "processPack.confirm" });

    await expect(
      t.mutation(processPacks.save, {
        ...renewal,
        ownerId: "another owner",
        supersedes: v1.id,
      }),
    ).rejects.toThrow(/Only the pack's owner/);
    const v2 = await t.mutation(processPacks.save, {
      ...renewal,
      ownerId,
      inputs: ["expirationDate", "licenseClass"],
      supersedes: v1.id,
    });
    if (v2.kind !== "created") throw new Error("Expected a new version");
    await expect(
      t.mutation(processPacks.save, { ...renewal, ownerId, supersedes: v1.id }),
    ).rejects.toThrow(/already been replaced/);

    expect(
      await t.query(processPacks.findMatch, {
        caseId,
        jurisdiction: "us/ca",
        terms: "driver license renewal",
      }),
    ).toMatchObject([{ id: v2.id }]);
    await answer(t, caseId, { expirationDate: "2027-01-09" });
    const pinned = await send(t, caseId, { type: "review.approve" });
    expect(pinned).toMatchObject({
      status: "done",
      processPack: { definition: { id: v1.id, inputs: ["expirationDate"] } },
    });
  });

  test("save rejects a referral on a missing input, or a bad jurisdiction", async () => {
    const { t } = await start();
    await expect(
      t.mutation(processPacks.save, {
        ...renewal,
        referral: { kind: "advice", when: { input: "nope", equals: "yes" } },
      }),
    ).rejects.toThrow(/isn't an input/);
    await expect(
      t.mutation(processPacks.save, { ...renewal, jurisdiction: "California" }),
    ).rejects.toThrow(/jurisdiction path/);
  });
});

describe("selecting a pack for a case", () => {
  test("the model compares the candidates and the case pins its choice", async () => {
    const { t, caseId } = await start();
    const ownerId = await owner(t, caseId);
    const saved = await t.mutation(processPacks.save, { ownerId, ...renewal });
    if (saved.kind !== "created") throw new Error("Expected a new pack");
    model.replies.push(
      request({ jurisdiction: "us/ca", searchTerms: "extend driving permit" }),
      choose(1),
    );
    const proposed = await send(t, caseId, {
      type: "intake.submit",
      goal: "Extend my California driving permit.",
    });
    expect(proposed.processPack).toMatchObject({
      status: "proposed",
      definition: { id: saved.id },
    });
    await send(t, caseId, { type: "processPack.confirm" });
    await answer(t, caseId, { expirationDate: "2027-01-09" });
    expect(await send(t, caseId, { type: "review.approve" })).toMatchObject({
      status: "done",
      processPack: { status: "confirmed", definition: { id: saved.id } },
    });
  });

  test("a drafted pack is saved on confirmation, and a reworded case reuses it (live run)", async () => {
    const { t, caseId } = await start();
    const before = await read(t, caseId);
    const goal = "I got a letter about wage garnishment and I need help.";
    model.replies.push(
      JSON.stringify({ reply: "Got it.", goal }),
      request({
        jurisdiction: "us/ca",
        authority: "state court",
        searchTerms: "wage garnishment notice review",
      }),
      JSON.stringify(recipe),
    );
    const proposed = await chat(t, caseId, goal);
    expect(proposed.processPack).toMatchObject({
      status: "proposed",
      draft: { ...recipe, jurisdiction: "us/ca", authority: "state court" },
    });
    expect(await ownPacks(t, before.userId)).toHaveLength(0);
    await expect(
      t.mutation(api.easygov.case.public.send, {
        caseId,
        expectedSeq: before.seq,
        event: { type: "processPack.confirm" },
      }),
    ).rejects.toThrow(/case has changed/);

    const confirmed = await send(t, caseId, { type: "processPack.confirm" });
    const packId = confirmed.processPack?.definition?.id;
    expect(packId).toBeDefined();
    expect(confirmed).toMatchObject({
      waitingFor: "answers",
      processPack: {
        status: "confirmed",
        definition: { inputQuestions: recipe.inputQuestions },
      },
    });
    expect(confirmed.processPack?.draft).toBeUndefined();
    const review = await answer(t, caseId, { noticeDate: "2026-11-01" });
    expect(JSON.parse(review.artifact?.summary ?? "{}")).toMatchObject({
      process: recipe.title,
      output: recipe.output,
    });

    // The second wording the live run used names the authority differently.
    const nextId = await t.mutation(api.easygov.case.public.startCase, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    model.replies.push(
      request({
        jurisdiction: "us/ca",
        authority: "courts",
        searchTerms: "wage garnishment understand notice",
      }),
      choose(1),
    );
    const next = await send(t, nextId, {
      type: "intake.submit",
      goal: "What does this wage garnishment notice from the court mean?",
    });
    expect(next.processPack).toMatchObject({
      status: "proposed",
      definition: { id: packId },
    });
    expect(next.processPack?.draft).toBeUndefined();
    expect(await ownPacks(t, before.userId)).toHaveLength(1);
  });

  test("a borderline referral still reuses a saved pack for the same task (live replay)", async () => {
    const { t, caseId } = await start();
    const ownerId = await owner(t, caseId);
    const saved = await t.mutation(processPacks.save, {
      ownerId,
      ...garnishment,
    });
    if (saved.kind !== "created") throw new Error("Expected a saved pack");
    model.replies.push(
      request({
        kind: "referral",
        jurisdiction: "us/ca",
        authority: "California state court",
        searchTerms: "wage withholding notice credit card judgment",
      }),
      choose(1),
    );
    const found = await send(t, caseId, {
      type: "intake.submit",
      goal: "Understand a California wage-withholding notice for a credit-card judgment.",
    });
    expect(found.processPack).toMatchObject({
      status: "proposed",
      definition: { id: saved.id },
    });
    expect(found.processPack?.referral).toBeUndefined();
  });

  test("a pack saved after drafting pauses confirmation and can be reused", async () => {
    const { t, caseId } = await start();
    const ownerId = await owner(t, caseId);
    model.replies.push(
      request({ jurisdiction: "us/ca", searchTerms: "wage garnishment" }),
      JSON.stringify(recipe),
    );
    await send(t, caseId, {
      type: "intake.submit",
      goal: "Garnishment notice",
    });
    const existing = await t.mutation(processPacks.save, {
      ...garnishment,
      ownerId,
    });
    if (existing.kind !== "created") throw new Error("Expected a saved pack");

    await expect(
      send(t, caseId, {
        type: "processPack.confirm",
        reviewedPackIds: [existing.id],
      }),
    ).rejects.toThrow(/Review the current possible matches/);
    const reviewing = await send(t, caseId, { type: "processPack.confirm" });
    expect(reviewing).toMatchObject({
      waitingFor: "pack",
      processPack: {
        status: "proposed",
        duplicateReview: { matches: [{ id: existing.id }] },
      },
    });
    const reused = await send(t, caseId, {
      type: "processPack.useExisting",
      packId: existing.id,
    });
    expect(reused).toMatchObject({
      waitingFor: "answers",
      processPack: { status: "confirmed", definition: { id: existing.id } },
    });
    expect(await ownPacks(t, ownerId)).toHaveLength(1);
  });

  test("a distinct draft is saved after the person reviews the candidates", async () => {
    const { t, caseId } = await start();
    const ownerId = await owner(t, caseId);
    const saved = await t.mutation(processPacks.save, { ...renewal, ownerId });
    if (saved.kind !== "created") throw new Error("Expected a saved pack");
    const replacement = {
      ...recipe,
      title: "Replace a missing driver's license",
      description: "Prepare a replacement checklist for a missing license.",
      aliases: ["replace missing driver license"],
    };
    model.replies.push(
      request({ jurisdiction: "us/ca", searchTerms: "replace driver license" }),
      choose(0),
      JSON.stringify(replacement),
    );
    const proposed = await send(t, caseId, {
      type: "intake.submit",
      goal: "Replace my missing CA DL",
    });
    expect(proposed.processPack?.draft?.title).toBe(replacement.title);
    const reviewing = await send(t, caseId, { type: "processPack.confirm" });
    expect(reviewing.processPack?.duplicateReview?.matches[0]?.id).toBe(
      saved.id,
    );
    const accepted = await send(t, caseId, {
      type: "processPack.confirm",
      reviewedPackIds: [saved.id],
    });
    expect(accepted.waitingFor).toBe("answers");
    expect(accepted.processPack?.definition?.id).not.toBe(saved.id);
  });

  test("a request without a usable jurisdiction asks where", async () => {
    const { t, caseId } = await start();
    model.replies.push(request({ jurisdiction: "California" }));
    const found = await send(t, caseId, {
      type: "intake.submit",
      goal: "Renew my license",
    });
    expect(found).toMatchObject({
      waitingFor: "goal",
      processPack: { status: "rejected" },
    });
  });
});
