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
import { chosen, definitionOf, draftOf } from "../case/schema";
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
  output: {
    title: "Renewal request",
    checklist: ["Check the renewal notice."],
    letter: "My license expires on {{expirationDate}}.",
  },
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
  output: {
    title: "Notice review preparation",
    checklist: ["Accept the court and case number on the notice."],
    letter: "I received a notice dated {{noticeDate}}.",
  },
};
// What the model writes when asked to draft that process. It asks one
// question the letter doesn't use.
const recipe = {
  title: garnishment.title,
  description: garnishment.description,
  aliases: garnishment.aliases,
  inputQuestions: [
    { key: "noticeDate", question: "What date is on the notice?" },
    { key: "rules", question: "Which exemptions do the court rules allow?" },
  ],
  output: garnishment.output,
};

// What the research model reports before a draft is written.
const sources = [
  "https://www.courts.ca.gov/garnishment",
  "https://www.courts.ca.gov/forms/wg-006",
];
const notes =
  `File a claim of exemption (${sources[0]}). ` +
  `Use form WG-006: \`${sources[1]}\`. See also ${sources[0]}.`;

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

  test("one shared word doesn't make a look-alike; a shared form does", async () => {
    const { t } = await start();
    const petition = {
      title: "Spouse immigrant petition",
      description: "Organize a family-based green card petition.",
      aliases: ["Form I-130 and adjustment of status"],
      jurisdiction: "us",
      forms: ["I-130"],
      inputs: ["route"],
    };
    // Only "form" in common with "IRS change of address (Form 8822)".
    expect(await t.mutation(processPacks.save, petition)).toMatchObject({
      kind: "created",
    });
    // Different words, same form number.
    expect(
      await t.mutation(processPacks.save, {
        ...petition,
        title: "Tell the tax office you moved",
        description: "Update where your tax mail goes.",
        aliases: [],
        forms: ["irs 8822"],
      }),
    ).toMatchObject({
      kind: "reviewDuplicates",
      packs: [{ title: "IRS change of address (Form 8822)" }],
    });
  });

  test("an input nothing reads is refused, unless the pack fills in a form", async () => {
    const { t } = await start();
    const { output: _output, ...unread } = renewal;
    await expect(t.mutation(processPacks.save, unread)).rejects.toThrow(
      /Nothing reads "expirationDate"/,
    );
    expect(
      await t.mutation(processPacks.save, { ...unread, forms: ["DL 44"] }),
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
    await send(t, caseId, { type: "goal.set", goal: "Renew my CA DL" });
    await send(t, caseId, { type: "pack.accept" });

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
      forms: ["DL-44"],
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
    const pinned = await send(t, caseId, { type: "artifact.accept" });
    expect(pinned).toMatchObject({
      status: "done",
      selection: { definition: { id: v1.id, inputs: ["expirationDate"] } },
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
      type: "goal.set",
      goal: "Extend my California driving permit.",
    });
    expect(proposed.selection).toMatchObject({
      status: "proposed",
      definition: { id: saved.id },
    });
    await send(t, caseId, { type: "pack.accept" });
    await answer(t, caseId, { expirationDate: "2027-01-09" });
    expect(await send(t, caseId, { type: "artifact.accept" })).toMatchObject({
      status: "done",
      selection: { status: "accepted", definition: { id: saved.id } },
    });
  });

  test("an accepted draft runs on its own case, and is never saved (live run)", async () => {
    const { t, caseId } = await start();
    const before = await read(t, caseId);
    const goal = "I got a letter about wage garnishment and I need help.";
    const drafting = [
      request({
        jurisdiction: "us/ca",
        authority: "state court",
        searchTerms: "wage garnishment notice review",
      }),
      notes,
      JSON.stringify(recipe),
    ];
    model.replies.push(JSON.stringify({ reply: "Got it.", goal }), ...drafting);
    const proposed = await chat(t, caseId, goal);
    // Only the question the letter reads is asked.
    const asked = [recipe.inputQuestions[0]];
    expect(proposed.selection).toMatchObject({
      status: "proposed",
      draft: {
        title: recipe.title,
        // The pages the research named travel with the checklist.
        output: { ...recipe.output, sources },
        jurisdiction: "us/ca",
        authority: "state court",
        inputs: ["noticeDate"],
        inputQuestions: asked,
      },
    });
    await expect(
      t.mutation(api.easygov.case.public.send, {
        caseId,
        expectedSeq: before.seq,
        event: { type: "pack.accept" },
      }),
    ).rejects.toThrow(/case has changed/);

    const accepted = await send(t, caseId, { type: "pack.accept" });
    expect(accepted).toMatchObject({
      waitingFor: "answers",
      selection: {
        status: "accepted",
        definition: { inputs: ["noticeDate"], inputQuestions: asked },
        draft: { title: recipe.title },
      },
    });
    expect(definitionOf(accepted.selection)?.id).toBeUndefined();
    const review = await answer(t, caseId, { noticeDate: "2026-11-01" });
    expect(review.artifact?.letter).toBe(
      "I received a notice dated 2026-11-01.",
    );
    expect(JSON.parse(review.artifact?.summary ?? "{}")).toMatchObject({
      process: recipe.title,
      output: { ...recipe.output, sources },
    });
    expect(await send(t, caseId, { type: "artifact.accept" })).toMatchObject({
      status: "done",
    });

    // The same request again finds nothing saved, and is drafted afresh.
    expect(await ownPacks(t, before.userId)).toHaveLength(0);
    const nextId = await t.mutation(api.easygov.case.public.startCase, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    model.replies.push(...drafting);
    const next = await send(t, nextId, { type: "goal.set", goal });
    expect(definitionOf(next.selection)).toBeUndefined();
    expect(draftOf(next.selection)?.title).toBe(recipe.title);
  });

  test("a draft with no letter asks nothing: the checklist goes straight to review", async () => {
    const { t, caseId } = await start();
    const { letter: _letter, ...checklist } = recipe.output;
    model.replies.push(
      request({ jurisdiction: "us/ca", searchTerms: "wage garnishment" }),
      "The search found nothing.",
      JSON.stringify({ ...recipe, output: checklist }),
    );
    const proposed = await send(t, caseId, {
      type: "goal.set",
      goal: "Garnishment notice",
    });
    expect(draftOf(proposed.selection)).toMatchObject({
      inputs: [],
      inputQuestions: [],
    });
    // No pages found: the checklist carries no sources.
    expect(draftOf(proposed.selection)?.output?.sources).toBeUndefined();
    const review = await send(t, caseId, { type: "pack.accept" });
    expect(review.waitingFor).toBe("review");
    expect(JSON.parse(review.artifact?.summary ?? "{}")).toMatchObject({
      output: checklist,
    });
    expect(await send(t, caseId, { type: "artifact.accept" })).toMatchObject({
      status: "done",
    });
  });

  test("a draft asks about the person's situation, and their checklist is cut to it", async () => {
    const { t, caseId } = await start();
    const steps = [
      "Check your renewal notice.",
      "To renew online, sign in and pay.",
      "To renew by mail, follow the notice.",
    ];
    model.replies.push(
      request({ jurisdiction: "us/ca", searchTerms: "license renewal" }),
      notes,
      JSON.stringify({
        ...recipe,
        inputQuestions: [],
        situationQuestions: [
          { key: "method", question: "How do you want to renew?" },
        ],
        output: { title: "Renewal", checklist: steps },
      }),
    );
    const proposed = await send(t, caseId, {
      type: "goal.set",
      goal: "Renew my California license",
    });
    // The situation question is an input because tailoring reads it.
    expect(proposed.selection).toMatchObject({
      draft: { inputs: ["method"], output: { tailorBy: ["method"] } },
    });
    // After accepting: nothing found in the conversation, then (once
    // answered) the model keeps steps 1 and 2, and a step that isn't there.
    model.replies.push(
      JSON.stringify({ answers: [] }),
      JSON.stringify({ keep: [2, 1, 9] }),
    );
    await send(t, caseId, { type: "pack.accept" });
    const review = await answer(t, caseId, { method: "online" });
    expect(review).toMatchObject({
      waitingFor: "review",
      artifact: { checklist: [steps[0], steps[1]] },
    });
    // Changing the answer cuts it again; a model that fails keeps every step.
    model.failing = true;
    const again = await answer(t, caseId, { method: "by mail" });
    expect(again.artifact?.checklist).toEqual(steps);
    model.failing = false;
    expect(await send(t, caseId, { type: "artifact.accept" })).toMatchObject({
      status: "done",
    });
  });

  test("a pack can't be tailored by something it doesn't ask", async () => {
    const { t } = await start();
    await expect(
      t.mutation(processPacks.save, {
        ...renewal,
        output: { ...renewal.output, tailorBy: ["method"] },
      }),
    ).rejects.toThrow(/tailored by "method"/);
    // Tailoring is a reader: an input it uses needs no letter or form.
    expect(
      await t.mutation(processPacks.save, {
        ...renewal,
        inputs: ["expirationDate", "method"],
        output: { ...renewal.output, tailorBy: ["method"] },
      }),
    ).toMatchObject({ kind: "created" });
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
      type: "goal.set",
      goal: "Understand a California wage-withholding notice for a credit-card judgment.",
    });
    expect(found.selection).toMatchObject({
      status: "proposed",
      definition: { id: saved.id },
    });
    expect(found.selection?.status).toBe("proposed");
    expect(chosen(found.selection)?.kind).toBe("pack");
  });

  test("a request without a usable jurisdiction asks where", async () => {
    const { t, caseId } = await start();
    model.replies.push(request({ jurisdiction: "California" }));
    const found = await send(t, caseId, {
      type: "goal.set",
      goal: "Renew my license",
    });
    expect(found).toMatchObject({
      waitingFor: "goal",
      // The agent asked where: the person didn't turn anything down.
      selection: { status: "rejected", reason: "clarification" },
    });
  });
});
