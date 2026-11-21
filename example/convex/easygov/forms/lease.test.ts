// @vitest-environment node
// The places among the hosted browsers that every case shares.
import { afterEach, expect, test, vi } from "vitest";
import { internal } from "../../_generated/api";
import { initConvexTest } from "../../setup.test";
import type { T } from "../case/cases.testkit";
import { BROWSER_LEASE_MS, MAX_BROWSERS } from "./data";

const data = internal.easygov.forms.data;
const take = (t: T) => t.mutation(data.takeBrowserLease, {});
const leases = (t: T) =>
  t.run((ctx) => ctx.db.query("browserLeases").collect());

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("the limit is under what the service allows", () => {
  expect(MAX_BROWSERS).toBeLessThan(24);
  // A lease outlasts the service's own 90 second session.
  expect(BROWSER_LEASE_MS).toBeGreaterThan(90_000);
});

test("places are given up to the limit, and no further", async () => {
  const t = initConvexTest();
  for (let i = 0; i < MAX_BROWSERS; i++) expect(await take(t)).not.toBeNull();
  expect(await take(t)).toBeNull();
  expect(await take(t)).toBeNull();
  expect(await leases(t)).toHaveLength(MAX_BROWSERS);
});

test("a place given back is free again, and giving it back twice is fine", async () => {
  const t = initConvexTest();
  const held = [];
  for (let i = 0; i < MAX_BROWSERS; i++) held.push((await take(t))!);
  expect(await take(t)).toBeNull();
  await t.mutation(data.releaseBrowserLease, { leaseId: held[0] });
  await t.mutation(data.releaseBrowserLease, { leaseId: held[0] });
  expect(await take(t)).not.toBeNull();
  expect(await take(t)).toBeNull();
});

test("a lease never given back expires, and is cleared away when one is next taken", async () => {
  vi.useFakeTimers();
  const t = initConvexTest();
  for (let i = 0; i < MAX_BROWSERS; i++) await take(t);
  // Just short of expiring, every place is still held.
  vi.advanceTimersByTime(BROWSER_LEASE_MS - 60_000);
  expect(await take(t)).toBeNull();
  expect(await leases(t)).toHaveLength(MAX_BROWSERS);
  // Once they expire the places are free, and the old rows are gone.
  vi.advanceTimersByTime(120_000);
  const fresh = await take(t);
  expect(fresh).not.toBeNull();
  expect((await leases(t)).map((lease) => lease._id)).toEqual([fresh]);
});

test("reading a page in a browser that fails gives its place back", async () => {
  vi.stubEnv("BROWSERBASE_API_KEY", "key");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  // The service won't start a browser: nothing leaves this test.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 500 })),
  );
  const t = initConvexTest();
  const answer = await t.action(internal.easygov.forms.actions.readLinks, {
    url: "https://www.ssa.gov/forms/",
    way: "browser",
    spend: true,
  });
  expect(answer).toMatchObject({
    ok: false,
    why: "unreachable",
    cost: { browser: 1 },
  });
  expect(await leases(t)).toHaveLength(0);
});

test("with every place taken a case's browser is busy, and nothing is recorded", async () => {
  vi.stubEnv("BROWSERBASE_API_KEY", "key");
  const fetchMock = vi.fn(async () => new Response(null, { status: 500 }));
  vi.stubGlobal("fetch", fetchMock);
  const t = initConvexTest();
  for (let i = 0; i < MAX_BROWSERS; i++) await take(t);
  // The waits between asks are real, so they are skipped here.
  vi.spyOn(Math, "random").mockReturnValue(0);
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((run: () => void) => {
    queueMicrotask(run);
    return 0;
  }) as unknown as typeof setTimeout);
  const url = "https://www.ssa.gov/forms/ssa-561.pdf";
  const answer = await t.action(internal.easygov.forms.actions.fetchFile, {
    url,
    way: "browser",
    spend: true,
    code: "SSA-561",
    jurisdiction: "us",
  });
  vi.restoreAllMocks();
  expect(answer).toMatchObject({
    ok: false,
    why: "busy",
    cost: { browser: 0 },
  });
  // No browser was asked for, and the address is none the wiser.
  expect(fetchMock).not.toHaveBeenCalled();
  expect(
    await t.run((ctx) => ctx.db.query("formAddresses").collect()),
  ).toHaveLength(0);
  expect(await leases(t)).toHaveLength(MAX_BROWSERS);
});
