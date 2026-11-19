import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "../../../_generated/api";
import {
  model,
  read,
  resetCases,
  send,
  start,
  texts,
} from "../../case/cases.testkit";
import { irs8822, request } from "../../packs/packs.testkit";

vi.mock("../../../modelsForDemo", async () =>
  (await import("../../case/cases.testkit")).mockModels(),
);

describe("process pack selection", () => {
  afterEach(resetCases);

  test("rejecting the proposed process pack goes back to intake for a new goal", async () => {
    const { t, caseId } = await start();
    await send(t, caseId, { type: "intake.submit", goal: "Something" });
    let found = await send(t, caseId, { type: "processPack.reject" });
    expect(found).toMatchObject({
      currentStep: "intake",
      visits: { intake: 2, selectProcessPack: 1 },
    });

    // Selection wrote only its own field: the goal is still there, rejected.
    expect(found.intake).toEqual({ goal: "Something", version: 1 });
    expect(found.processPack).toEqual({ status: "rejected", goalVersion: 1 });

    // A new goal puts the rejection out of date, and the agent proposes again.
    found = await send(t, caseId, { type: "intake.submit", goal: "I moved" });
    expect(found.currentStep).toBe("selectProcessPack");
    expect(found.intake).toEqual({ goal: "I moved", version: 2 });
    expect(found.processPack).toMatchObject({
      status: "proposed",
      goalVersion: 2,
    });
    expect(found.processPack?.definition?.inputs).toEqual(irs8822.inputs);
  });

  test("stating the same goal again after a rejection is a new goal", async () => {
    const { t, caseId } = await start();
    await send(t, caseId, { type: "intake.submit", goal: "I moved" });
    await send(t, caseId, { type: "processPack.reject" });
    const found = await send(t, caseId, {
      type: "intake.submit",
      goal: "I moved",
    });
    expect(found).toMatchObject({
      currentStep: "selectProcessPack",
      intake: { goal: "I moved", version: 2 },
      processPack: { status: "proposed", goalVersion: 2 },
    });
  });

  test("selection returns to intake when the jurisdiction needs clarification", async () => {
    const { t, caseId } = await start();
    model.replies.push(
      request({ kind: "unclear", message: "Where is the property located?" }),
    );
    const found = await send(t, caseId, {
      type: "intake.submit",
      goal: "Sue my landlord",
    });
    expect(found).toMatchObject({
      status: "active",
      currentStep: "intake",
      processPack: { status: "rejected" },
    });
    expect((await texts(t, caseId)).at(-1)).toEqual([
      "assistant",
      "Where is the property located?",
    ]);
  });

  test("a proposal that can't be kept posts no message", async () => {
    const { t, caseId } = await start();
    // Someone else's pack: this person can't see it, so it can't be proposed.
    const saved = await t.mutation(internal.easygov.packs.data.save, {
      ...irs8822,
      title: "Demande de passeport",
      description: "Préparer une demande de passeport.",
      aliases: [],
      forms: [],
      jurisdiction: "fr",
      ownerId: "someone-else",
    });
    if (saved.kind !== "created") throw new Error("Expected a saved pack");
    await t.run((ctx) =>
      ctx.db.patch("cases", caseId, {
        intake: { goal: "Passeport", version: 1 },
      }),
    );
    const { workflowId } = await read(t, caseId);
    const kept = await t.mutation(
      internal.easygov.stages.selectProcessPack.data.record,
      {
        caseId,
        message: "Suggested process: Demande de passeport.",
        packId: saved.id,
        origin: { goalVersion: 1, workflowId: workflowId! },
      },
    );
    expect(kept).toBe(false);
    expect(await texts(t, caseId)).toEqual([]);
    expect((await read(t, caseId)).processPack).toBeUndefined();
  });

  test("a request for legal advice is confirmed as a referral, not a pack", async () => {
    const { t, caseId } = await start();
    model.replies.push(
      request({
        kind: "referral",
        message: "This needs a lawyer. I can refer you.",
      }),
    );
    let found = await send(t, caseId, {
      type: "intake.submit",
      goal: "Should I sue my former employer?",
    });
    expect(found.processPack).toEqual({
      status: "proposed",
      goalVersion: 1,
      referral: true,
    });
    found = await send(t, caseId, { type: "processPack.confirm" });
    expect(found).toMatchObject({
      status: "done",
      visits: { legalReferral: 1 },
    });
    const referrals = await t.run((ctx) => ctx.db.query("referrals").collect());
    expect(referrals).toMatchObject([{ kind: "advice" }]);
  });
});
