// A packet says, per form, whether an official page links the file used.
import { afterEach, expect, test, vi } from "vitest";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { read, resetCases, send, start, type T } from "./cases.testkit";
import { editionCheck } from "./state";

vi.mock("../../modelsForDemo", async () =>
  (await import("./cases.testkit")).mockModels(),
);
afterEach(resetCases);

const form = (code: string, backed?: boolean) => ({
  code,
  sourceUrl: `https://example.org/${code}.pdf`,
  inputs: [],
  ...(backed !== undefined && { backed }),
});

/** A case on an accepted pack, pinned with these packet forms. */
async function caseWith(forms: ReturnType<typeof form>[]) {
  const { t, caseId } = await start();
  await send(t, caseId, { type: "goal.set", goal: "Change my IRS address" });
  await send(t, caseId, { type: "pack.accept" });
  await t.run(async (ctx) => {
    const c = (await ctx.db.get("cases", caseId))!;
    if (c.selection?.status !== "accepted" || c.selection.kind !== "pack")
      throw new Error("Expected an accepted pack");
    await ctx.db.patch("cases", caseId, {
      selection: {
        ...c.selection,
        definition: { ...c.selection.definition, packetForms: forms },
      },
    });
  });
  return { t, caseId };
}

/** Records a packet in which each of `codes` was filled. */
async function build(t: T, caseId: Id<"cases">, codes: string[]) {
  const { fingerprint } = await t.query(
    internal.easygov.case.data.packetInput,
    { caseId },
  );
  const documents = [];
  for (const code of codes) {
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob([code])));
    documents.push({
      code,
      sourceUrl: form(code).sourceUrl,
      storageId,
      omissions: [],
      toComplete: [],
    });
  }
  await t.mutation(internal.easygov.case.data.recordArtifact, {
    caseId,
    packet: { fingerprint, documents, openItems: [] },
  });
  return (await read(t, caseId)).artifact!;
}

test("an unbacked form is left to check, filled or not", async () => {
  const { t, caseId } = await caseWith([
    form("A-1", false),
    form("B-2", true),
    form("C-3", false),
  ]);
  // C-3 could not be filled: it has no document, and is still to check.
  const artifact = await build(t, caseId, ["A-1", "B-2"]);
  expect(artifact.openItems).toEqual(
    expect.arrayContaining([
      editionCheck(form("A-1")),
      editionCheck(form("C-3")),
    ]),
  );
  expect(artifact.openItems?.join("\n")).not.toContain("B-2");
});

test("a pack that doesn't record it builds the packet it always did", async () => {
  const { t, caseId } = await caseWith([form("A-1")]);
  const artifact = await build(t, caseId, ["A-1"]);
  expect(artifact.documents).toHaveLength(1);
  expect(artifact.openItems?.join("\n") ?? "").not.toMatch(/edition/);
});
