// @vitest-environment node
// Keeping published packs fresh: each pack's forms asked again on a
// schedule, against a stand-in network.
import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { initConvexTest } from "../../setup.test";
import type { FileAnswer } from "../forms/actions";
import {
  fakeNetwork,
  formPdf,
  restoreNetwork,
  scanPdf,
  servePdf,
  serveStatus,
} from "../forms/network.testkit";
import { standingOf, stalenessOf } from "./freshness";
import { ssaAppeal } from "./packs.testkit";

vi.mock("../../modelsForDemo", async () =>
  (await import("../case/cases.testkit")).mockModels(),
);
afterEach(restoreNetwork);

const cost = {
  downloads: 1,
  browser: 0,
  pages: 0,
  bytes: 0,
  held: 0,
  reused: 0,
  unchanged: 0,
  reads: 0,
};
const facts = { pages: 1, places: 1, language: "en" as const };
const edition = "e1" as Id<"formEditions">;
const file = (
  more: Partial<{ editionId: Id<"formEditions">; expired: boolean }> = {},
): FileAnswer => ({
  ok: true,
  editionId: more.editionId ?? edition,
  facts: { ...facts, ...(more.expired && { expired: true }) },
  namedBy: "text",
  cost,
});
const no = (why: Extract<FileAnswer, { ok: false }>["why"]): FileAnswer => ({
  ok: false,
  why,
  note: why,
  cost,
});

describe("how a pack's form stands", () => {
  test("the same file, not expired, is current", () => {
    expect(standingOf(file(), edition)).toEqual({ standing: "current" });
  });
  test("another file at the address is a change", () => {
    const other = "e2" as Id<"formEditions">;
    expect(standingOf(file({ editionId: other }), edition)).toEqual({
      standing: "changed",
    });
  });
  test("a file whose printed expiry has passed is expired", () => {
    expect(standingOf(file({ expired: true }), edition)).toEqual({
      standing: "expired",
    });
  });
  test.each(["gone", "unusable", "otherForm", "page"] as const)(
    "an address that is %s has lost the form",
    (why) => expect(standingOf(no(why), edition).standing).toBe("lost"),
  );
  test.each(["refused", "busy", "unspent", "unreachable"] as const)(
    "an ask that was %s says nothing about the form",
    (why) => expect(standingOf(no(why), edition).standing).toBe("unchecked"),
  );
});

test("a pack whose form changed at the authority is marked stale, and says what to check", async () => {
  vi.useFakeTimers();
  const t = initConvexTest();
  const url = "https://www.ssa.gov/forms/ssa-561.pdf";
  const first = await formPdf(["Form SSA-561 (08-2025)"]);
  const net = fakeNetwork({ [url]: servePdf(first) });
  // The pack fills the file found when it was made.
  const fetched = await t.action(internal.easygov.forms.actions.fetchFile, {
    jurisdiction: "us",
    code: "SSA-561",
    url,
    way: "request",
    spend: true,
  });
  if (!fetched.ok) throw new Error("Expected the form");
  const blueprintId = await t.run((ctx) =>
    ctx.db.insert("formBlueprints", {
      editionId: fetched.editionId,
      targets: [],
      mapping: [],
    }),
  );
  const saved = await t.mutation(internal.easygov.packs.data.createPack, {
    ...ssaAppeal,
    packetForms: [{ code: "SSA-561", sourceUrl: url, blueprintId, inputs: [] }],
    reviewedPackIds: [],
  });
  if (saved.kind !== "created") throw new Error("Expected a pack");
  const sweep = async () => {
    await t.mutation(internal.easygov.packs.freshness.sweepPacks, {
      cursor: null,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  };
  const staleness = () => t.run((ctx) => stalenessOf(ctx, saved.id));

  await sweep();
  expect(await staleness()).toEqual([]);
  const asked = net.asked(url);
  // Checked within the week, it isn't asked again.
  await sweep();
  expect(net.asked(url)).toBe(asked);

  // A week on, the authority publishes another edition at the address.
  vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60 * 1000);
  net.routes[url] = servePdf(await formPdf(["Form SSA-561 (03-2026)"]));
  await sweep();
  expect(await staleness()).toEqual([
    expect.stringContaining("The authority has changed SSA-561"),
  ]);

  // And later takes it down.
  vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60 * 1000);
  net.routes[url] = serveStatus(404);
  await sweep();
  expect(await staleness()).toEqual([
    expect.stringContaining("SSA-561 is no longer at"),
  ]);
});

test("a pack's form that only its link named still stands at the next check, while it has no words", async () => {
  vi.useFakeTimers();
  const t = initConvexTest();
  const url = "https://www.ssa.gov/forms/ssa-561.pdf";
  const net = fakeNetwork({ [url]: servePdf(await scanPdf()) });
  const saved = await t.mutation(internal.easygov.packs.data.createPack, {
    ...ssaAppeal,
    packetForms: [
      { code: "SSA-561", sourceUrl: url, inputs: [], namedBy: "link" },
    ],
    reviewedPackIds: [],
  });
  if (saved.kind !== "created") throw new Error("Expected a pack");
  const staleness = async () => {
    await t.mutation(internal.easygov.packs.freshness.sweepPacks, {
      cursor: null,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    return await t.run((ctx) => stalenessOf(ctx, saved.id));
  };

  expect(await staleness()).toEqual([]);
  // The authority puts a file with words there, of another form.
  vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60 * 1000);
  net.routes[url] = servePdf(await formPdf(["Form SSA-827 (11-2024)"]));
  expect(await staleness()).toHaveLength(1);
});

test("a pack whose form is on a site since revoked is marked stale at its next check", async () => {
  vi.useFakeTimers();
  const t = initConvexTest();
  const url = "https://forms.partner.org/ssa-561.pdf";
  fakeNetwork({ [url]: servePdf(await formPdf(["Form SSA-561 (08-2025)"])) });
  const site = (state: object) =>
    t.mutation(internal.easygov.forms.sites.putSites, {
      sites: [{ domain: "partner.org", ...state } as never],
      at: Date.now(),
    });
  // A link vouched for the site when the pack was made.
  await site({
    state: "vouched",
    name: "Partner",
    owner: { level: "national", country: "us" },
    via: {
      kind: "link",
      from: "https://www.ssa.gov/forms/",
      support: "back",
      steps: 1,
    },
  });
  const saved = await t.mutation(internal.easygov.packs.data.createPack, {
    ...ssaAppeal,
    packetForms: [
      { code: "SSA-561", sourceUrl: url, inputs: [], backed: true },
    ],
    reviewedPackIds: [],
  });
  if (saved.kind !== "created") throw new Error("Expected a pack");
  const staleness = async () => {
    await t.mutation(internal.easygov.packs.freshness.sweepPacks, {
      cursor: null,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    return await t.run((ctx) => stalenessOf(ctx, saved.id));
  };
  expect(await staleness()).toEqual([]);

  vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60 * 1000);
  await site({ state: "revoked" });
  expect(await staleness()).toEqual([
    expect.stringContaining("check the authority’s site"),
  ]);
});
