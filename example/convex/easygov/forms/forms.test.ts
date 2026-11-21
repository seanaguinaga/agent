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
  const formId = await t.mutation(forms.createForm, {
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
  const kept = await t.mutation(internal.easygov.forms.data.keepFile, {
    sha256: "a".repeat(64),
    fresh: {
      formId,
      sourceUrl: "https://www.irs.gov/pub/irs-pdf/f8822.pdf",
      code: "IRS-8822",
      jurisdiction: "us",
      edition: {
        storageId,
        pages,
        edition,
        fillable,
        targets,
        obtained: {
          via: "request",
          url: "https://www.irs.gov/pub/irs-pdf/f8822.pdf",
        },
        opened: false,
      },
    },
  });
  const editionId = kept.editionId as Id<"formEditions">;
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
    const { editionId } = await recorded(t);
    expect(
      await t.mutation(internal.easygov.forms.data.keepFile, {
        sha256: "a".repeat(64),
      }),
    ).toMatchObject({ editionId, kept: false });
    expect(await t.query(forms.listForms, {})).toMatchObject([
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
      t.mutation(forms.updateMapping, {
        editionId,
        reviewed: false,
        mapping: [{ target: "p9.f9", input: "fullName" }],
      }),
    ).rejects.toThrow(/isn't a target/);
    await expect(
      t.mutation(forms.updateMapping, {
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
    await t.mutation(forms.updateMapping, {
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
  await t.mutation(forms.updateMapping, { editionId, mapping, reviewed: true });
  const packId = await t.mutation(forms.publishPack, {
    editionId,
    profile: [{ input: "newAddress", updates: "homeAddress" }],
  });
  await t.mutation(api.easygov.profile.public.setFact, {
    key: "name",
    value: { given: "Ada", family: "Lovelace" },
  });
  await t.mutation(api.easygov.profile.public.setFact, {
    key: "homeAddress",
    value: {
      street: "1 Old Road",
      city: "Oakland",
      state: "CA",
      postalCode: "94612",
      country: "US",
    },
  });
  const caseId = await t.mutation(api.easygov.case.public.createCase, {
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
    waitingFor: "review",
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
  expect(await t.query(forms.getDocumentUrl, { caseId })).toMatch(/^https?:/);

  // A form filled from answers that have since moved on (a profile save
  // reaches a case at any time) is behind them: it isn't put up for review.
  const { document, fingerprint } = review.artifact!;
  const fill = internal.easygov.case.data.recordArtifact;
  await t.mutation(fill, {
    caseId,
    document: { ...document!, fingerprint: "the answers before" },
  });
  expect(await read(t, caseId)).toMatchObject({
    waitingFor: null,
    artifact: { fingerprint: "the answers before" },
  });
  await t.mutation(fill, { caseId, document: { ...document!, fingerprint } });
  expect((await read(t, caseId)).waitingFor).toBe("review");

  // A pack fills this edition now, so its mapping can be corrected but not
  // taken back to unreviewed.
  await expect(
    t.mutation(forms.updateMapping, { editionId, mapping, reviewed: false }),
  ).rejects.toThrow(/stays reviewed/);
  await t.mutation(forms.updateMapping, { editionId, mapping, reviewed: true });

  expect(await send(t, caseId, { type: "artifact.accept" })).toMatchObject({
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
    t.mutation(forms.updateMapping, {
      editionId,
      reviewed: true,
      mapping: [
        mapping[0],
        { ...mapping[1], includes: undefined, equals: "gift" },
      ],
    }),
  ).rejects.toThrow(/mix "equals" and "includes"/);
  await t.mutation(forms.updateMapping, { editionId, mapping, reviewed: true });
  const packId = await t.mutation(forms.publishPack, { editionId });
  const caseId = await t.mutation(api.easygov.case.public.createCase, {
    packId,
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const started = await read(t, caseId);
  expect(started.selection).toMatchObject({
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
  await t.mutation(api.easygov.case.public.sendEvent, {
    caseId,
    expectedSeq: started.seq,
    event: { type: "answers.set", key: "newAddress", value: "2 New Street" },
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const review = await read(t, caseId);
  expect(review.waitingFor).toBe("review");
  await expect(
    t.mutation(api.easygov.case.public.sendEvent, {
      caseId,
      expectedSeq: started.seq,
      event: { type: "artifact.accept" },
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

test.each([
  ["IRS-8822", "f8822", "Change my IRS address", /^3a Your name/],
  ["W-9", "fw9", "Give a payer my taxpayer certification", /name/i],
] as const)(
  "compiles an unseen %s from research and reads the result from the shared PDF",
  async (code, filename, goal, label) => {
    vi.useFakeTimers();
    const t = initConvexTest();
    const sourceUrl = `https://www.irs.gov/pub/irs-pdf/${filename}.pdf`;
    const blocked = "https://www.irs.gov/forms/blocked.pdf";
    const firstSource = code === "W-9" ? blocked : sourceUrl;
    const attempts: string[] = [];
    const bytes = new Uint8Array(
      readFileSync(new URL(`./fixtures/${filename}.pdf`, import.meta.url)),
    );
    const target = (await inspectPdf(bytes)).targets.find(
      (t) => t.kind === "text" && label.test(t.label),
    )!;
    expect(target).toBeDefined();
    const originalFetch = globalThis.fetch;
    const mock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        attempts.push(String(input));
        if (String(input) === blocked)
          return new Response(null, { status: 403 });
        if (String(input) === sourceUrl)
          return new Response(bytes.slice().buffer, {
            headers: { "Content-Type": "application/pdf" },
          });
        return originalFetch(input, init);
      });
    try {
      const { model } = await import("../case/cases.testkit");
      const { request } = await import("../packs/packs.testkit");
      const caseId = await t.mutation(api.easygov.case.public.createCase, {});
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      model.replies.push(
        request({
          jurisdiction: "us",
          authority: "IRS",
          forms: [code],
          searchTerms: goal,
        }),
        JSON.stringify({
          findings: `Use ${code}.`,
          methods: [],
          forms: [{ code, pdfUrl: firstSource, requiredBy: "" }],
          sources: [],
        }),
        JSON.stringify({
          title: goal,
          description: goal,
          aliases: [],
          inputQuestions: [],
          ...(code === "W-9" && {
            officialForms: [{ code, sourceUrl: firstSource }],
          }),
          referralKind: "tax",
          output: {
            title: goal,
            checklist: ["Sign the form."],
            letter: "Identification: {{taxpayerId}}",
          },
        }),
        ...(code === "W-9" ? [sourceUrl] : []),
        JSON.stringify({
          entries: [
            {
              target: target.id,
              use: "input",
              input: "fullName",
              question: "",
              tick: "",
              option: "",
              note: "",
            },
          ],
        }),
      );
      const proposed = await send(t, caseId, { type: "goal.set", goal });
      expect(proposed.selection).toMatchObject({
        kind: "draft",
        draft: {
          output: { letter: "Identification: [complete by hand]" },
          packetForms: [{ code, blueprintId: expect.any(String) }],
        },
      });
      if (code === "W-9") {
        expect(
          attempts.filter((url) => url === blocked || url === sourceUrl),
        ).toEqual([blocked, sourceUrl]);
      }
      model.replies.push(JSON.stringify({ answers: [] }));
      await send(t, caseId, { type: "pack.accept" });
      const notice = await t.run((ctx) =>
        ctx.storage.store(
          new Blob(
            [
              "Applicant: Ada Lovelace. Reference AB-12. Decision date 2026-01-02.",
            ],
            { type: "text/plain" },
          ),
        ),
      );
      model.replies.push(
        JSON.stringify({
          stated: [],
          what: "The notice names Ada Lovelace, reference AB-12, decision dated 2026-01-02.",
          answers: [{ key: "fullName", value: "Ada Lovelace" }],
          facts: [{ fact: "name", text: "Ada Lovelace" }],
        }),
      );
      const evidence = await send(t, caseId, {
        type: "evidence.add",
        storageId: notice,
        name: "Notice.txt",
      });
      expect(evidence.suggestions.fullName).toBe("Ada Lovelace");
      expect(
        (await t.query(api.easygov.profile.public.getProfile, {})).proposals,
      ).toContainEqual(
        expect.objectContaining({
          fact: "name",
          text: "Ada Lovelace",
          source: "Notice.txt",
        }),
      );
      model.replies.push(
        JSON.stringify({ openItems: ["Sign the printed form."] }),
      );
      const review = await send(t, caseId, { type: "answers.accept" });
      const document = review.artifact?.documents?.[0];
      expect(review).toMatchObject({
        phase: "review",
        artifact: {
          revision: 1,
          // No official page was read that links this file as the form, so
          // the person is also left the edition to check.
          openItems: [
            expect.stringContaining("is the current edition"),
            "Sign the printed form.",
          ],
        },
      });
      expect(
        await t.action(internal.easygov.forms.actions.readFilled, {
          storageId: document!.storageId,
        }),
      ).toMatchObject({ texts: ["Ada Lovelace"] });
      await send(t, caseId, { type: "artifact.accept" });
      await send(t, caseId, { type: "referral.share" });
      const firmId = await t.mutation(internal.easygov.firms.data.createFirm, {
        userId: "test user",
        name: "Tax Counsel",
        coverage: [{ kind: "tax", jurisdiction: "us" }],
      });
      const [preview] = await t.query(api.easygov.firms.public.listPreviews, {
        firmId,
      });
      const referralId = preview.id;
      await t.mutation(api.easygov.firms.public.acceptReferral, {
        firmId,
        referralId,
      });
      await t.mutation(api.easygov.firms.public.requestInformation, {
        firmId,
        referralId,
        question: "Have you signed the form?",
      });
      const handoff = await t.query(api.easygov.case.public.handoff, {
        caseId,
      });
      await t.mutation(api.easygov.case.public.answerLawyer, {
        caseId,
        questionId: handoff!.questions[0].id,
        answer: "Yes.",
      });
      model.replies.push(JSON.stringify({ openItems: ["Keep a copy."] }));
      const revised = await send(t, caseId, { type: "artifact.reassess" });
      expect(revised.artifact?.revision).toBe(2);
      const handed = await t.query(api.easygov.firms.public.getPacket, {
        firmId,
        referralId,
      });
      expect(handed).toMatchObject({
        artifact: {
          revision: 1,
          documents: [{ storageId: document!.storageId }],
        },
        questions: [{ answer: "Yes." }],
      });
      expect(handed.documentUrls?.[document!.storageId]).toBeTruthy();
    } finally {
      mock.mockRestore();
    }
  },
);
