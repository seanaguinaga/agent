// @vitest-environment node
// A real form through the backend: recorded, mapped, published as a pack,
// and filled for a case from the person's profile.
import { readFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { initConvexTest } from "../../setup.test";
import { read, resetCases, send, type T } from "../case/cases.testkit";
import { isOfficialHost } from "./data";
import { inspectPdf } from "./pdf";

vi.mock("../../modelsForDemo", async () =>
  (await import("../case/cases.testkit")).mockModels(),
);
afterEach(resetCases);

const forms = api.easygov.forms.data;
const original = new Uint8Array(
  readFileSync(new URL("./fixtures/f8822.pdf", import.meta.url)),
);

/** Records the fixture as a fetched edition, as `fetchForm` would. */
async function recorded(t: T, bytes = original) {
  const formId = await t.mutation(forms.register, {
    code: "IRS-8822",
    title: "Change of Address",
    jurisdiction: "us",
    sourceUrl: "https://www.irs.gov/pub/irs-pdf/f8822.pdf",
  });
  const { pages, edition, fillable, targets } = await inspectPdf(bytes);
  const storageId = await t.run((ctx) =>
    ctx.storage.store(
      new Blob([bytes.slice().buffer], { type: "application/pdf" }),
    ),
  );
  const editionId = (await t.mutation(internal.easygov.forms.data.recordFetch, {
    formId,
    sha256: "a".repeat(64),
    fresh: { storageId, pages, edition, fillable, targets },
  })) as Id<"formEditions">;
  const at = (pattern: RegExp) =>
    targets.find((target) => pattern.test(target.label))!.id;
  const mapping = [
    { target: at(/^Individual income tax/), constant: "yes" },
    { target: at(/^3a Your name/), input: "fullName" },
    {
      target: at(/^3b Your social/),
      leave: {
        why: "confidential" as const,
        note: "Your Social Security number.",
      },
    },
    { target: at(/^6a Your old address/), input: "homeAddressLine" },
    { target: at(/^7 New address/), input: "newAddress" },
  ];
  return { formId, editionId, mapping, targets };
}

test("a form is fetched only from its authority's own site", () => {
  expect(isOfficialHost("https://www.irs.gov/pub/irs-pdf/f8822.pdf")).toBe(
    true,
  );
  expect(isOfficialHost("https://www.dmv.ca.gov/portal/x.pdf")).toBe(true);
  expect(isOfficialHost("http://www.irs.gov/f.pdf")).toBe(false);
  expect(isOfficialHost("https://irs.gov.example.com/f.pdf")).toBe(false);
  expect(isOfficialHost("https://example.com/f8822.pdf")).toBe(false);
});

describe("an edition", () => {
  test("is known by its bytes: the same hash again is not a new edition", async () => {
    const t = initConvexTest();
    const { formId, editionId } = await recorded(t);
    expect(
      await t.mutation(internal.easygov.forms.data.recordFetch, {
        formId,
        sha256: "a".repeat(64),
      }),
    ).toBe(editionId);
    expect(await t.query(forms.list, {})).toMatchObject([
      {
        code: "IRS-8822",
        editions: [
          {
            edition: "Rev. February 2021",
            targets: 25,
            mappingStatus: "none",
            // Published isn't the same as still accepted.
            currency: "unconfirmed",
          },
        ],
      },
    ]);
  });

  test("a mapping is checked, and fills nothing until a person has reviewed it", async () => {
    const t = initConvexTest();
    const { editionId, mapping } = await recorded(t);
    await expect(
      t.mutation(forms.saveMapping, {
        editionId,
        reviewed: false,
        mapping: [{ target: "p9.f9", input: "fullName" }],
      }),
    ).rejects.toThrow(/isn't a target/);
    await expect(
      t.mutation(forms.saveMapping, {
        editionId,
        reviewed: false,
        mapping: [
          {
            target: mapping[1].target,
            input: "fullName",
            leave: { why: "signature" as const, note: "x" },
          },
        ],
      }),
    ).rejects.toThrow(/exactly one/);
    await t.mutation(forms.saveMapping, {
      editionId,
      mapping,
      reviewed: false,
    });
    await expect(t.mutation(forms.publishPack, { editionId })).rejects.toThrow(
      /Review the mapping/,
    );
  });
});

test("a case on the form's pack is filled from the profile, and read back", async () => {
  vi.useFakeTimers();
  const t = initConvexTest();
  const { editionId, mapping } = await recorded(t);
  await t.mutation(forms.saveMapping, { editionId, mapping, reviewed: true });
  const packId = await t.mutation(forms.publishPack, {
    editionId,
    profile: [{ input: "newAddress", updates: "homeAddress" }],
  });
  await t.mutation(api.easygov.profile.public.save, {
    key: "name",
    value: { given: "Ada", family: "Lovelace" },
  });
  await t.mutation(api.easygov.profile.public.save, {
    key: "homeAddress",
    value: {
      street: "1 Old Road",
      city: "Oakland",
      state: "CA",
      postalCode: "94612",
      country: "US",
    },
  });
  const caseId = await t.mutation(api.easygov.case.public.startCase, {
    packId,
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  // The pack asks what the mapping reads; the profile answers two of three.
  expect(await read(t, caseId)).toMatchObject({
    waitingFor: "answers",
    answers: {
      fullName: "Ada Lovelace",
      homeAddressLine: "1 Old Road, Oakland, CA 94612",
    },
  });
  const review = await send(t, caseId, {
    type: "answers.set",
    key: "newAddress",
    value: "2 New Street, Berkeley, CA 94704",
  });
  expect(review).toMatchObject({
    waitingFor: "approval",
    artifact: {
      document: {
        omissions: [],
        toComplete: [
          { why: "confidential", note: "Your Social Security number." },
        ],
      },
    },
  });
  // The stored PDF is the official form, holding what the person said.
  const stored = await t.run(async (ctx) => {
    const blob = await ctx.storage.get(review.artifact!.document!.storageId);
    return await blob!.arrayBuffer();
  });
  // No timer pauses: this test runs on fake timers.
  const filled = await PDFDocument.load(stored, { parseSpeed: Infinity });
  const values = filled
    .getForm()
    .getFields()
    .map((field) =>
      "getText" in field
        ? (field as { getText(): string | undefined }).getText()
        : undefined,
    )
    .filter(Boolean);
  expect(values).toEqual([
    "Ada Lovelace",
    "1 Old Road, Oakland, CA 94612",
    "2 New Street, Berkeley, CA 94704",
  ]);
  expect(await t.query(forms.documentUrl, { caseId })).toMatch(/^https?:/);
  expect(await send(t, caseId, { type: "review.approve" })).toMatchObject({
    status: "done",
  });
});

test("a group of boxes is asked as one question, and typing isn't refused for a stale view", async () => {
  vi.useFakeTimers();
  const t = initConvexTest();
  const { editionId, targets } = await recorded(t);
  const at = (pattern: RegExp) =>
    targets.find((target) => pattern.test(target.label))!.id;
  const mapping = [
    {
      target: at(/^Individual income tax/),
      input: "returns",
      includes: "individual",
      question: "Which returns does this change affect?",
    },
    { target: at(/^Gift, estate/), input: "returns", includes: "gift" },
    { target: at(/^7 New address/), input: "newAddress" },
  ];
  // One question can't be both pick-one and check-all-that-apply.
  await expect(
    t.mutation(forms.saveMapping, {
      editionId,
      reviewed: true,
      mapping: [
        mapping[0],
        { ...mapping[1], includes: undefined, equals: "gift" },
      ],
    }),
  ).rejects.toThrow(/mix "equals" and "includes"/);
  await t.mutation(forms.saveMapping, { editionId, mapping, reviewed: true });
  const packId = await t.mutation(forms.publishPack, { editionId });
  const caseId = await t.mutation(api.easygov.case.public.startCase, {
    packId,
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const started = await read(t, caseId);
  expect(started.processPack).toMatchObject({
    definition: {
      inputQuestions: [
        {
          key: "returns",
          question: "Which returns does this change affect?",
          multiple: true,
          choices: [
            { value: "individual" },
            { value: "gift", label: expect.stringMatching(/^Gift, estate/) },
          ],
        },
        { key: "newAddress" },
      ],
    },
  });
  await expect(
    send(t, caseId, { type: "answers.set", key: "returns", value: "business" }),
  ).rejects.toThrow(/Choose any of: individual, gift/);
  // Tidied into the form's order.
  const answered = await send(t, caseId, {
    type: "answers.set",
    key: "returns",
    value: "gift,individual",
  });
  expect(answered.answers.returns).toBe("individual,gift");

  // An answer typed against an old view is still taken: it writes its own
  // key. A decision isn't.
  await t.mutation(api.easygov.case.public.send, {
    caseId,
    expectedSeq: started.seq,
    event: { type: "answers.set", key: "newAddress", value: "2 New Street" },
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const review = await read(t, caseId);
  expect(review.waitingFor).toBe("approval");
  await expect(
    t.mutation(api.easygov.case.public.send, {
      caseId,
      expectedSeq: started.seq,
      event: { type: "review.approve" },
    }),
  ).rejects.toThrow(/case has changed/);

  // Both boxes are ticked on the form itself.
  const stored = await t.run(async (ctx) => {
    const blob = await ctx.storage.get(review.artifact!.document!.storageId);
    return await blob!.arrayBuffer();
  });
  const filled = await PDFDocument.load(stored, { parseSpeed: Infinity });
  const ticked = filled
    .getForm()
    .getFields()
    .filter(
      (field) =>
        "isChecked" in field && (field as { isChecked(): boolean }).isChecked(),
    );
  expect(ticked).toHaveLength(2);
});
