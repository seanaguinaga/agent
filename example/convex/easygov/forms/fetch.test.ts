// @vitest-environment node
// Asking an address for a form, and a page for its links, end to end: the
// two actions against a stand-in network, with what they keep read back
// from the tables. No request leaves the machine.
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { internal } from "../../_generated/api";
import { initConvexTest } from "../../setup.test";
import type { T } from "../case/cases.testkit";
import {
  browserKey,
  fakeNetwork,
  formPdf,
  kept,
  restoreNetwork,
  servePage,
  servePdf,
  serveRevalidating,
  serveStatus,
  withoutWaiting,
  xfaPdf,
} from "./network.testkit";
import { inspectPdf } from "./pdf";

vi.mock("../../modelsForDemo", async () =>
  (await import("../case/cases.testkit")).mockModels(),
);

// Opening a file is where one ask can be held while another finishes: a
// test sets `hold.until` to make the second of two asks wait there.
const hold = vi.hoisted(() => ({
  opened: 0,
  until: undefined as Promise<unknown> | undefined,
}));
vi.mock("./open", async (original) => {
  const real = await original<typeof import("./open")>();
  return {
    ...real,
    openForFilling: async (bytes: Uint8Array) => {
      if (++hold.opened > 1) await hold.until;
      return await real.openForFilling(bytes);
    },
  };
});

const actions = internal.easygov.forms.actions;
const ssa = "https://www.ssa.gov/forms";
const address = `${ssa}/ssa-561.pdf`;
const form = { jurisdiction: "us", code: "SSA-561" };

/** The form SSA-561 as the authority publishes it now. */
let ssa561: Uint8Array;
/** Another form altogether. */
let ssa827: Uint8Array;

beforeAll(async () => {
  ssa561 = await formPdf(["Form SSA-561 (08-2025)"]);
  ssa827 = await formPdf(["Form SSA-827 (11-2024)"]);
});

let restoreKey: () => void;
beforeEach(() => {
  restoreKey = browserKey(undefined);
  hold.opened = 0;
  hold.until = undefined;
});
afterEach(() => {
  restoreKey();
  restoreNetwork();
});

/** Asks an address for the form by a plain request, spending. */
const fetchFile = (
  t: T,
  url: string,
  more: {
    code?: string;
    linkedAs?: string;
    from?: string;
    way?: "request" | "browser";
    spend?: boolean;
  } = {},
) =>
  t.action(actions.fetchFile, {
    ...form,
    url,
    way: "request",
    spend: true,
    ...more,
  });

const readLinks = (
  t: T,
  url: string,
  more: { from?: string; way?: "request" | "browser"; spend?: boolean } = {},
) => t.action(actions.readLinks, { url, way: "request", spend: true, ...more });

test("the generated form is read as a form: its words, its place to write and its revision", async () => {
  const { opening, targets, pages } = await inspectPdf(ssa561);
  expect(opening).toContain("Form SSA-561 (08-2025)");
  expect(targets).toHaveLength(1);
  expect(pages).toBe(1);
});

describe("a file asked for again", () => {
  test("is downloaded and kept once, then only asked whether it has changed", async () => {
    const t = initConvexTest();
    const net = fakeNetwork({
      [address]: serveRevalidating(
        ssa561,
        '"v1"',
        "Wed, 20 Aug 2025 10:00:00 GMT",
      ),
    });

    const first = await fetchFile(t, address);
    expect(first).toMatchObject({
      ok: true,
      facts: { pages: 1, places: 1, language: "en", revision: 202508 },
      cost: { downloads: 1, held: 0, unchanged: 0, reused: 0 },
    });
    expect(first.cost.bytes).toBe(ssa561.length);
    // The first request had nothing to compare against.
    expect(net.requests[0].headers.get("if-none-match")).toBeNull();
    expect(net.requests[0].headers.get("if-modified-since")).toBeNull();
    const after = await kept(t);
    expect(after.editions).toHaveLength(1);
    expect(after.blobs).toHaveLength(1);

    const second = await fetchFile(t, address);
    expect(net.requests).toHaveLength(2);
    expect(net.requests[1].headers.get("if-none-match")).toBe('"v1"');
    expect(net.requests[1].headers.get("if-modified-since")).toBe(
      "Wed, 20 Aug 2025 10:00:00 GMT",
    );
    expect(second).toMatchObject({
      ok: true,
      cost: { downloads: 1, held: 1, unchanged: 1, bytes: 0 },
    });
    expect(second.ok && first.ok && second.editionId).toBe(
      first.ok && first.editionId,
    );
    // Nothing was stored again.
    const again = await kept(t);
    expect(again.editions).toHaveLength(1);
    expect(again.blobs).toHaveLength(1);
    expect(again.addresses).toHaveLength(1);
    expect(again.addresses[0]).toMatchObject({ outcome: "file", failures: 0 });
  });

  test("is downloaded again from a server that can't say, but the same bytes are no second edition", async () => {
    const t = initConvexTest();
    const net = fakeNetwork({ [address]: servePdf(ssa561) });

    const first = await fetchFile(t, address);
    const second = await fetchFile(t, address);

    expect(net.asked(address)).toBe(2);
    expect(net.requests[1].headers.get("if-none-match")).toBeNull();
    expect(net.requests[1].headers.get("if-modified-since")).toBeNull();
    expect(second).toMatchObject({
      ok: true,
      cost: { downloads: 1, held: 1, unchanged: 0, bytes: ssa561.length },
    });
    expect(second.ok && second.editionId).toBe(first.ok && first.editionId);
    const after = await kept(t);
    expect(after.editions).toHaveLength(1);
    expect(after.blobs).toHaveLength(1);
  });

  test("new bytes at the same address are a new edition, and the old one stays", async () => {
    const t = initConvexTest();
    const revised = await formPdf(["Form SSA-561 (02-2026)"]);
    const net = fakeNetwork({ [address]: servePdf(ssa561) });
    const first = await fetchFile(t, address);
    net.routes[address] = servePdf(revised);

    const second = await fetchFile(t, address);

    expect(second).toMatchObject({ ok: true, facts: { revision: 202602 } });
    expect(second.ok && second.editionId).not.toBe(first.ok && first.editionId);
    expect((await kept(t)).editions).toHaveLength(2);
  });
});

test("one file served at two addresses is read and kept once", async () => {
  const t = initConvexTest();
  const mirror = "https://secure.ssa.gov/apps10/forms/SSA-561-U2.pdf";
  const net = fakeNetwork({
    [address]: servePdf(ssa561),
    [mirror]: servePdf(ssa561),
  });

  const first = await fetchFile(t, address);
  const second = await fetchFile(t, mirror);

  // The second address was new, so it was downloaded; the file was not.
  expect(net.asked(mirror)).toBe(1);
  expect(second).toMatchObject({
    ok: true,
    cost: { downloads: 1, held: 0, bytes: ssa561.length },
  });
  expect(second.ok && second.editionId).toBe(first.ok && first.editionId);
  expect(second.ok && second.facts).toEqual(first.ok && first.facts);
  const after = await kept(t);
  expect(after.editions).toHaveLength(1);
  expect(after.blobs).toHaveLength(1);
  // Each address is remembered as serving that one file.
  expect(
    after.addresses.map((row) => row.outcome === "file" && row.editionId),
  ).toEqual([after.editions[0]._id, after.editions[0]._id]);
});

// Two addresses that serve one file nobody has kept yet, asked at the same
// time (as `locateForm` asks a form's leads): `keepFile` looks and keeps in
// one step, so the file is one edition and one stored copy however the two
// asks interleave.
test("one file served at two addresses asked at once is kept once", async () => {
  const t = initConvexTest();
  const mirror = "https://secure.ssa.gov/apps10/forms/SSA-561-U2.pdf";
  fakeNetwork({ [address]: servePdf(ssa561), [mirror]: servePdf(ssa561) });
  // Whichever ask opens the file second waits until the first has answered,
  // so the two never store at the same instant (the test backend can't).
  let release = () => {};
  hold.until = new Promise<void>((resolve) => (release = resolve));

  const asks = [fetchFile(t, address), fetchFile(t, mirror)];
  await Promise.race(asks);
  release();
  const [first, second] = await Promise.all(asks);

  expect(first).toMatchObject({ ok: true });
  expect(second).toMatchObject({ ok: true });
  const after = await kept(t);
  expect(after.editions).toHaveLength(1);
  expect(after.blobs).toHaveLength(1);
  expect(second.ok && second.editionId).toBe(first.ok && first.editionId);
});

describe("an address that gives no file", () => {
  test("a 404 is kept as gone, and asking again within the hour makes no request", async () => {
    const t = initConvexTest();
    const net = fakeNetwork({ [address]: serveStatus(404) });

    const first = await fetchFile(t, address);
    expect(first).toMatchObject({
      ok: false,
      why: "gone",
      cost: { downloads: 1, reused: 0 },
    });
    expect((await kept(t)).addresses).toMatchObject([
      { outcome: "gone", failures: 1, url: address },
    ]);

    const second = await fetchFile(t, address);
    expect(net.asked(address)).toBe(1);
    expect(second).toMatchObject({
      ok: false,
      why: "gone",
      cost: { downloads: 0, held: 1, reused: 1, bytes: 0 },
    });
    // The browser isn't sent there either.
    restoreKey();
    restoreKey = browserKey("key");
    const third = await fetchFile(t, address, { way: "browser" });
    expect(third).toMatchObject({
      ok: false,
      why: "gone",
      cost: { browser: 0, reused: 1 },
    });
    expect(net.service).toHaveLength(0);
  });

  test("a failure stops standing after an hour, and the address is asked again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t = initConvexTest();
    const net = fakeNetwork({ [address]: serveStatus(404) });
    await fetchFile(t, address);
    net.routes[address] = servePdf(ssa561);

    vi.setSystemTime(Date.now() + 59 * 60 * 1000);
    expect(await fetchFile(t, address)).toMatchObject({ why: "gone" });
    expect(net.asked(address)).toBe(1);

    vi.setSystemTime(Date.now() + 2 * 60 * 1000);
    expect(await fetchFile(t, address)).toMatchObject({ ok: true });
    expect(net.asked(address)).toBe(2);
    expect((await kept(t)).addresses).toMatchObject([
      { outcome: "file", failures: 0 },
    ]);
  });

  test("a 403 is a refusal: nothing is kept against the address, and it is asked again", async () => {
    const t = initConvexTest();
    const net = fakeNetwork({ [address]: serveStatus(403) });

    const first = await fetchFile(t, address);
    expect(first).toMatchObject({
      ok: false,
      why: "refused",
      cost: { downloads: 1, bytes: 0 },
    });
    expect((await kept(t)).addresses).toHaveLength(0);

    const second = await fetchFile(t, address);
    expect(second).toMatchObject({ why: "refused", cost: { reused: 0 } });
    expect(net.asked(address)).toBe(2);
  });

  test("a request that never gets an answer is a refusal too", async () => {
    const t = initConvexTest();
    fakeNetwork({
      [address]: () => {
        throw new TypeError("fetch failed");
      },
    });
    expect(await fetchFile(t, address)).toMatchObject({
      ok: false,
      why: "refused",
    });
    expect((await kept(t)).addresses).toHaveLength(0);
  });

  test("told not to spend, an unknown address is unspent and no request is made", async () => {
    const t = initConvexTest();
    const net = fakeNetwork({ [address]: servePdf(ssa561) });

    const answer = await fetchFile(t, address, { spend: false });

    expect(answer).toEqual({
      ok: false,
      why: "unspent",
      note: "",
      cost: {
        downloads: 0,
        browser: 0,
        pages: 0,
        bytes: 0,
        held: 0,
        reused: 0,
        unchanged: 0,
      },
    });
    expect(net.requests).toHaveLength(0);
    expect((await kept(t)).addresses).toHaveLength(0);
  });

  test("an address off the authority's sites is never requested", async () => {
    const t = initConvexTest();
    const net = fakeNetwork({});
    expect(
      await fetchFile(t, "https://forms.example.com/ssa-561.pdf"),
    ).toMatchObject({ ok: false, why: "unusable", cost: { downloads: 0 } });
    expect(net.requests).toHaveLength(0);
  });

  const cdn = "https://cdn.example.com/ssa-561.pdf";
  const mirror = "https://mirror.example.org/ssa-561.pdf";
  const to = (location: string) => () =>
    new Response(null, { status: 302, headers: { location } });

  test("a redirect is followed one step off a government's site, and no further", async () => {
    const t = initConvexTest();
    const net = fakeNetwork({
      [address]: to(cdn),
      [cdn]: servePdf(ssa561),
      [`${ssa}/moved.pdf`]: to("https://cdn.example.com/again"),
      "https://cdn.example.com/again": to(mirror),
      [mirror]: servePdf(ssa561),
    });
    expect(await fetchFile(t, address)).toMatchObject({ ok: true });
    expect(await fetchFile(t, `${ssa}/moved.pdf`)).toMatchObject({
      ok: false,
      why: "unusable",
    });
    expect(net.asked(mirror)).toBe(0);
  });

  test("an address on nobody's site is read only as a government's page links it", async () => {
    const t = initConvexTest();
    const net = fakeNetwork({
      [cdn]: servePdf(ssa561),
      [mirror]: to(cdn),
      "https://www.dmv.org/": servePage('<a href="/reg-343.pdf">REG 343</a>'),
      [`${ssa}/`]: servePage(
        `<a href="${cdn}">SSA-561</a><a href="${mirror}">A mirror</a><a href="https://www.dmv.org/">DMV</a>`,
      ),
      [`${ssa}/other`]: servePage("<a href='/forms/'>Forms</a>"),
    });
    const unread = { ok: false, why: "unusable", cost: { downloads: 0 } };
    // Come by from a search, or from a page that is itself on nobody's site.
    expect(await fetchFile(t, cdn)).toMatchObject(unread);
    expect(await fetchFile(t, cdn, { from: mirror })).toMatchObject(unread);
    expect(await readLinks(t, "https://www.dmv.org/")).toMatchObject({
      ok: false,
      why: "unusable",
    });
    // Nor on the caller's word that a government's page links it: the page
    // has to have been read, and to link it.
    expect(await fetchFile(t, cdn, { from: `${ssa}/` })).toMatchObject(unread);
    await readLinks(t, `${ssa}/other`);
    expect(await fetchFile(t, cdn, { from: `${ssa}/other` })).toMatchObject(
      unread,
    );
    expect(net.addresses()).toEqual([`${ssa}/other`]);
    await readLinks(t, `${ssa}/`);
    // Linked from a government's page, it is read: but not where it then
    // redirects, off to another site that is nobody's.
    expect(await fetchFile(t, mirror, { from: `${ssa}/` })).toMatchObject({
      ok: false,
      why: "unusable",
    });
    expect(net.asked(cdn)).toBe(0);
    expect(await fetchFile(t, cdn, { from: `${ssa}/` })).toMatchObject({
      ok: true,
    });
    // A page on nobody's site keeps only its links to its own site and onto
    // governments' sites. Its own are read only once the site is vouched.
    net.routes["https://www.dmv.org/"] = servePage(
      `<a href="/reg-343.pdf">A copy</a><a href="${address}">SSA-561</a><a href="${cdn}">Elsewhere</a>`,
    );
    const links = await readLinks(t, "https://www.dmv.org/", {
      from: `${ssa}/`,
    });
    const copy = "https://www.dmv.org/reg-343.pdf";
    expect(links.ok && links.links.map(({ url }) => url)).toEqual([
      copy,
      address,
    ]);
    expect(
      await fetchFile(t, copy, { from: "https://www.dmv.org/" }),
    ).toMatchObject(unread);
  });

  test("a redirect within the authority's sites is followed to the file", async () => {
    const t = initConvexTest();
    const moved = `${ssa}/2025/ssa-561.pdf`;
    const net = fakeNetwork({
      [address]: () =>
        new Response(null, { status: 301, headers: { location: moved } }),
      [moved]: servePdf(ssa561),
    });
    expect(await fetchFile(t, address)).toMatchObject({ ok: true });
    expect(net.asked(moved)).toBe(1);
  });

  test("bytes that are neither a PDF nor a page are kept as unusable", async () => {
    const t = initConvexTest();
    const net = fakeNetwork({
      [address]: () => new Response("PK\u0003\u0004 not a pdf"),
    });
    expect(await fetchFile(t, address)).toMatchObject({
      ok: false,
      why: "unusable",
    });
    expect(await fetchFile(t, address)).toMatchObject({
      why: "unusable",
      cost: { reused: 1 },
    });
    expect(net.asked(address)).toBe(1);
  });
});

test("a lead that is a web page answers as a page, and its links are kept for reading", async () => {
  const t = initConvexTest();
  const page = `${ssa}/ssa-561.html`;
  const net = fakeNetwork({
    [page]: servePage(`<!doctype html><html><body>
      <h2>Form SSA-561 | Request for Reconsideration</h2>
      <a href="/forms/ssa-561.pdf">Download PDF</a>
      <a href="https://example.com/ssa-561.pdf">A copy elsewhere</a>
    </body></html>`),
  });

  const answer = await fetchFile(t, page);
  expect(answer).toMatchObject({
    ok: false,
    why: "page",
    cost: { downloads: 1 },
  });
  const after = await kept(t);
  expect(after.addresses).toMatchObject([{ outcome: "page", failures: 0 }]);
  expect(after.editions).toHaveLength(0);

  // Reading the same address for its links costs no request.
  const links = await readLinks(t, page);
  expect(net.asked(page)).toBe(1);
  expect(links).toMatchObject({
    ok: true,
    cost: { pages: 0, held: 1, reused: 1 },
  });
  // A government's page vouches for one link: every link on it is kept.
  expect(links.ok && links.links).toEqual([
    {
      url: address,
      label: "Download PDF",
      pdf: true,
      under: "Form SSA-561 | Request for Reconsideration",
    },
    {
      url: "https://example.com/ssa-561.pdf",
      label: "A copy elsewhere",
      pdf: true,
      under: "Form SSA-561 | Request for Reconsideration",
    },
  ]);
});

describe("whether a file is the form", () => {
  test("a file that doesn't print the code is another form, and isn't kept", async () => {
    const t = initConvexTest();
    fakeNetwork({ [address]: servePdf(ssa827) });

    const answer = await fetchFile(t, address);

    expect(answer).toMatchObject({ ok: false, why: "otherForm" });
    expect(answer.cost.bytes).toBe(ssa827.length);
    const after = await kept(t);
    expect(after.editions).toHaveLength(0);
    expect(after.blobs).toHaveLength(0);
    // What the file is stays known, so it needn't be read again.
    expect(after.addresses).toMatchObject([
      { outcome: "file", facts: { places: 1 } },
    ]);
    expect(after.addresses[0]).toMatchObject({
      opening: expect.stringContaining("SSA-827"),
    });
  });

  test("the same file is the other form when asked for as that one", async () => {
    const t = initConvexTest();
    fakeNetwork({ [address]: servePdf(ssa827) });
    await fetchFile(t, address);
    expect(await fetchFile(t, address, { code: "SSA-827" })).toMatchObject({
      ok: true,
    });
    expect((await kept(t)).editions).toHaveLength(1);
  });

  // Canada's IMM 5257 is such a form: a plain reading of its one page gives
  // only "Please wait...".
  test("an XFA form is named by the words in its XFA, and has no place to write in", async () => {
    const t = initConvexTest();
    fakeNetwork({
      [address]: servePdf(await xfaPdf(["IMM 5257 (09-2023) E"])),
    });

    expect(await fetchFile(t, address, { code: "IMM 5257" })).toMatchObject({
      ok: true,
      facts: { pages: 1, places: 0, language: "en", revision: 202309 },
    });
    const [edition] = (await kept(t)).editions;
    expect(edition).toMatchObject({ fillable: false, targets: [] });
    // Its words are all it is known by: it is no other form.
    expect(await fetchFile(t, address, { code: "IMM 5709" })).toMatchObject({
      ok: false,
      why: "otherForm",
    });
  });

  // The authority renamed "SSA-561-U2" to "SSA-561": its file prints only
  // the new name, and its page still links it under the form's number.
  test("a renamed form is accepted only when the page's words and the file both carry its number", async () => {
    const t = initConvexTest();
    const net = fakeNetwork({ [address]: servePdf(ssa561) });
    const renamed = { code: "SSA-561-U2" };

    expect(await fetchFile(t, address, renamed)).toMatchObject({
      ok: false,
      why: "otherForm",
    });
    // Words that say nothing of the form don't vouch for the file.
    expect(
      await fetchFile(t, address, { ...renamed, linkedAs: "English PDF" }),
    ).toMatchObject({ ok: false, why: "otherForm" });
    expect((await kept(t)).editions).toHaveLength(0);

    const linked = await fetchFile(t, address, {
      ...renamed,
      linkedAs: "English PDF Form SSA-561 | Request for Reconsideration",
    });
    expect(linked).toMatchObject({
      ok: true,
      facts: { places: 1, revision: 202508 },
    });
    const after = await kept(t);
    expect(after.editions).toHaveLength(1);
    expect(after.blobs).toHaveLength(1);
    expect(net.asked(address)).toBe(3);
  });

  test("the page's words don't let through a file that carries another number", async () => {
    const t = initConvexTest();
    fakeNetwork({ [address]: servePdf(ssa827) });
    expect(
      await fetchFile(t, address, {
        code: "SSA-561-U2",
        linkedAs: "Form SSA-561 | Request for Reconsideration",
      }),
    ).toMatchObject({ ok: false, why: "otherForm" });
  });

  test("a file the server says is unchanged is still judged for the form asked", async () => {
    const t = initConvexTest();
    const net = fakeNetwork({
      [address]: serveRevalidating(
        ssa561,
        '"v1"',
        "Wed, 20 Aug 2025 10:00:00 GMT",
      ),
    });
    await fetchFile(t, address);

    const other = await fetchFile(t, address, { code: "SSA-827" });

    expect(net.requests[1].headers.get("if-none-match")).toBe('"v1"');
    expect(other).toMatchObject({
      ok: false,
      why: "otherForm",
      cost: { unchanged: 1, bytes: 0 },
    });
  });
});

// These depend on how the hosted browser is reached (`browser.ts`).
describe("through the hosted browser", () => {
  test("with no browser set up the answer is busy, and nothing is asked", async () => {
    const t = initConvexTest();
    const net = fakeNetwork({ [address]: servePdf(ssa561) });

    const answer = await fetchFile(t, address, { way: "browser" });

    expect(answer).toMatchObject({
      ok: false,
      why: "busy",
      cost: { browser: 0, downloads: 0 },
    });
    expect(net.requests).toHaveLength(0);
    expect(net.service).toHaveLength(0);
    expect((await kept(t)).addresses).toHaveLength(0);
  });

  test("a service that answers 429 is busy, and nothing is kept against the address", async () => {
    restoreKey();
    restoreKey = browserKey("key");
    vi.useFakeTimers();
    const t = initConvexTest();
    const net = fakeNetwork({}, { sessions: 429 });

    const answer = await withoutWaiting(
      fetchFile(t, address, { way: "browser" }),
    );

    expect(answer).toMatchObject({ ok: false, why: "busy" });
    expect(net.service.length).toBeGreaterThan(0);
    expect(net.service.every(({ url }) => url.endsWith("/sessions"))).toBe(
      true,
    );
    expect(net.requests).toHaveLength(0);
    expect((await kept(t)).addresses).toHaveLength(0);
  });

  test("a browser that downloads nothing is kept as unreachable, and the next ask is answered from memory", async () => {
    restoreKey();
    restoreKey = browserKey("key");
    vi.useFakeTimers();
    const t = initConvexTest();
    const net = fakeNetwork({});

    const first = await withoutWaiting(
      fetchFile(t, address, { way: "browser" }),
    );

    expect(first).toMatchObject({
      ok: false,
      why: "unreachable",
      cost: { browser: 1, bytes: 0 },
    });
    expect((await kept(t)).addresses).toMatchObject([
      { outcome: "unreachable", failures: 1 },
    ]);
    // The browser was let go.
    expect(net.service.at(-1)).toMatchObject({
      method: "POST",
      url: expect.stringMatching(/\/sessions\/s1$/),
    });

    const asked = net.service.length;
    const second = await withoutWaiting(
      fetchFile(t, address, { way: "browser" }),
    );
    expect(second).toMatchObject({
      ok: false,
      why: "unreachable",
      cost: { browser: 0, held: 1, reused: 1 },
    });
    expect(net.service).toHaveLength(asked);
    // Nor is a plain request made for it.
    expect(await fetchFile(t, address)).toMatchObject({
      why: "unreachable",
      cost: { downloads: 0, reused: 1 },
    });
    expect(net.requests).toHaveLength(0);
  });

  test("a file the browser downloads is kept as the form, without a plain request", async () => {
    restoreKey();
    restoreKey = browserKey("key");
    const t = initConvexTest();
    const net = fakeNetwork({}, { download: ssa561 });

    const answer = await fetchFile(t, address, { way: "browser" });

    expect(answer).toMatchObject({
      ok: true,
      facts: { places: 1 },
      cost: { browser: 1, downloads: 0, bytes: ssa561.length },
    });
    expect(net.requests).toHaveLength(0);
    expect((await kept(t)).editions).toMatchObject([
      { obtained: { via: "browser", url: address } },
    ]);
  });

  test("a page asked for with no browser set up is busy", async () => {
    const t = initConvexTest();
    const net = fakeNetwork({});
    expect(await readLinks(t, `${ssa}/`, { way: "browser" })).toMatchObject({
      ok: false,
      why: "busy",
      cost: { browser: 0 },
    });
    expect(net.service).toHaveLength(0);
    expect((await kept(t)).pages).toHaveLength(0);
  });

  test("a page asked for from a service that answers 429 is busy, and nothing is kept", async () => {
    restoreKey();
    restoreKey = browserKey("key");
    vi.useFakeTimers();
    const t = initConvexTest();
    fakeNetwork({}, { sessions: 429 });
    expect(
      await withoutWaiting(readLinks(t, `${ssa}/`, { way: "browser" })),
    ).toMatchObject({ ok: false, why: "busy" });
    expect((await kept(t)).pages).toHaveLength(0);
  });
});

describe("a page's links", () => {
  const index = `${ssa}/`;
  const html = `<html><body>
    <h1>Forms</h1>
    <a href="/forms/all.html">All forms</a>
    <h2>Form SSA-561 | Request for Reconsideration</h2>
    <a href="ssa-561.pdf">English PDF</a>
    <a href="ssa-561-sp.pdf">Spanish PDF</a>
    <h2>Form SSA-827 | Authorization to Disclose Information</h2>
    <a href="ssa-827.pdf">English PDF</a>
    <a href="https://www.adobe.com/reader">Get a PDF reader</a>
  </body></html>`;

  test("carry the heading they sit under, and say which are PDFs", async () => {
    const t = initConvexTest();
    fakeNetwork({ [index]: servePage(html) });

    const answer = await readLinks(t, index);

    expect(answer).toMatchObject({
      ok: true,
      cost: { pages: 1, held: 0, reused: 0 },
    });
    // PDFs first; a link off the government's sites is one link from it.
    expect(answer.ok && answer.links).toEqual([
      {
        url: `${ssa}/ssa-561.pdf`,
        label: "English PDF",
        pdf: true,
        under: "Form SSA-561 | Request for Reconsideration",
      },
      {
        url: `${ssa}/ssa-561-sp.pdf`,
        label: "Spanish PDF",
        pdf: true,
        under: "Form SSA-561 | Request for Reconsideration",
      },
      {
        url: `${ssa}/ssa-827.pdf`,
        label: "English PDF",
        pdf: true,
        under: "Form SSA-827 | Authorization to Disclose Information",
      },
      {
        url: `${ssa}/all.html`,
        label: "All forms",
        pdf: false,
        under: "Forms",
      },
      {
        url: "https://www.adobe.com/reader",
        label: "Get a PDF reader",
        pdf: false,
        under: "Form SSA-827 | Authorization to Disclose Information",
      },
    ]);
  });

  test("a page read once is not requested again", async () => {
    const t = initConvexTest();
    const net = fakeNetwork({ [index]: servePage(html) });
    const first = await readLinks(t, index);

    const second = await readLinks(t, index);

    expect(net.asked(index)).toBe(1);
    expect(second).toMatchObject({
      ok: true,
      cost: { pages: 0, held: 1, reused: 1 },
    });
    expect(second.ok && second.links).toEqual(first.ok && first.links);
    expect((await kept(t)).pages).toHaveLength(1);
  });

  test("a page is read again once its links are a day old", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t = initConvexTest();
    const net = fakeNetwork({ [index]: servePage(html) });
    await readLinks(t, index);
    vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
    expect(await readLinks(t, index)).toMatchObject({
      ok: true,
      cost: { pages: 1, reused: 0 },
    });
    expect(net.asked(index)).toBe(2);
  });

  test("a page that is gone is left alone for a while; one that refuses is not held against it", async () => {
    const t = initConvexTest();
    const net = fakeNetwork({
      [index]: serveStatus(404),
      [`${ssa}/all.html`]: serveStatus(403),
    });

    expect(await readLinks(t, index)).toMatchObject({
      ok: false,
      why: "gone",
      cost: { pages: 1 },
    });
    expect(await readLinks(t, index)).toMatchObject({
      ok: false,
      why: "gone",
      cost: { pages: 0, reused: 1 },
    });
    expect(net.asked(index)).toBe(1);

    expect(await readLinks(t, `${ssa}/all.html`)).toMatchObject({
      ok: false,
      why: "refused",
    });
    expect(await readLinks(t, `${ssa}/all.html`)).toMatchObject({
      why: "refused",
      cost: { pages: 1, reused: 0 },
    });
    expect(net.asked(`${ssa}/all.html`)).toBe(2);
    expect((await kept(t)).addresses).toMatchObject([{ outcome: "gone" }]);
  });

  test("told not to spend, an unread page is unspent and no request is made", async () => {
    const t = initConvexTest();
    const net = fakeNetwork({ [index]: servePage(html) });
    expect(await readLinks(t, index, { spend: false })).toMatchObject({
      ok: false,
      why: "unspent",
    });
    expect(net.requests).toHaveLength(0);
  });

  test("an address that serves a file is not a page", async () => {
    const t = initConvexTest();
    fakeNetwork({ [address]: servePdf(ssa561) });
    expect(await readLinks(t, address)).toMatchObject({
      ok: false,
      why: "unusable",
    });
  });
});

test("a file kept before its printed expiry is given as expired once that has passed", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2025-12-01"));
  const t = initConvexTest();
  const expiring = await formPdf(["Form SSA-561 (08-2025) Expires: 01/26"]);
  const net = fakeNetwork({
    [address]: serveRevalidating(
      expiring,
      '"v1"',
      "Wed, 20 Aug 2025 10:00:00 GMT",
    ),
  });

  const before = await fetchFile(t, address);
  expect(before).toMatchObject({ ok: true });
  expect(before).not.toHaveProperty("facts.expired");

  // The server says the file hasn't changed; the calendar has.
  vi.setSystemTime(new Date("2026-03-01"));
  expect(await fetchFile(t, address)).toMatchObject({
    ok: true,
    facts: { expired: true },
    cost: { unchanged: 1, bytes: 0 },
  });
  // What is kept never says it has expired: that is worked out each time.
  expect((await kept(t)).addresses[0]).not.toHaveProperty("facts.expired");
  expect(net.requests.length).toBeGreaterThan(1);
});

describe("an address that refuses a plain request, opened in the browser", () => {
  const page = `${ssa}/ssa-561.html`;

  test("is read as a page when it is one, so its links can be followed", async () => {
    restoreKey();
    restoreKey = browserKey("key");
    vi.useFakeTimers();
    const t = initConvexTest();
    const net = fakeNetwork(
      { [page]: serveStatus(403) },
      {
        page: {
          at: page,
          html: '<h2>Form SSA-561</h2><a href="/forms/ssa-561.pdf">English PDF</a>',
        },
      },
    );

    expect(
      await withoutWaiting(fetchFile(t, page, { way: "browser" })),
    ).toMatchObject({
      ok: false,
      why: "page",
      cost: { browser: 1 },
    });
    // Its links are kept, and read without opening a browser again.
    const asked = net.service.length;
    expect(await readLinks(t, page, { way: "browser" })).toMatchObject({
      ok: true,
      links: [{ url: `${ssa}/ssa-561.pdf`, label: "English PDF", pdf: true }],
      cost: { browser: 0, reused: 1 },
    });
    expect(net.service).toHaveLength(asked);
  });

  test("is unusable when the browser ends up two steps off a government's sites", async () => {
    restoreKey();
    restoreKey = browserKey("key");
    vi.useFakeTimers();
    const t = initConvexTest();
    const linked = "https://forms.example.org/ssa-561.html";
    fakeNetwork(
      {
        [linked]: serveStatus(403),
        [page]: servePage(`<a href="${linked}">SSA-561</a>`),
      },
      {
        page: {
          at: "https://forms.example.com/ssa-561.html",
          html: '<a href="https://www.ssa.gov/forms/ssa-561.pdf">SSA-561</a>',
        },
      },
    );
    await readLinks(t, page);

    expect(
      await withoutWaiting(
        readLinks(t, linked, { from: page, way: "browser" }),
      ),
    ).toMatchObject({ ok: false, why: "unusable" });
    expect((await kept(t)).addresses).toMatchObject([
      { outcome: "page" },
      { outcome: "unusable" },
    ]);
  });

  test("is read with the links its scripts add, in a shadow root or late", async () => {
    restoreKey();
    restoreKey = browserKey("key");
    vi.useFakeTimers();
    const t = initConvexTest();
    fakeNetwork(
      { [page]: serveStatus(403) },
      {
        page: {
          at: page,
          html: '<a href="/forms/">All forms</a><forms-list></forms-list>',
          // What scripts build once the page has loaded, a look apart.
          scripted: [
            '<h2>Form SSA-561</h2><a href="/forms/ssa-561.pdf">English PDF</a>',
            '<h2>Form SSA-827</h2><a href="/forms/ssa-827.pdf">English PDF</a>',
          ],
        },
      },
    );

    expect(
      await withoutWaiting(readLinks(t, page, { way: "browser" })),
    ).toMatchObject({
      ok: true,
      links: [
        { url: `${ssa}/ssa-561.pdf`, under: "Form SSA-561", pdf: true },
        { url: `${ssa}/ssa-827.pdf`, under: "Form SSA-827", pdf: true },
        { url: `${ssa}/`, label: "All forms", pdf: false },
      ],
    });
  });
});

test("a file larger than any form is refused without being held", async () => {
  const t = initConvexTest();
  const chunk = new Uint8Array(1024 * 1024);
  fakeNetwork({
    [address]: () => {
      let sent = 0;
      return new Response(
        new ReadableStream({
          pull(controller) {
            if (sent++ < 30) controller.enqueue(chunk);
            else controller.close();
          },
        }),
        { headers: { "content-type": "application/pdf" } },
      );
    },
  });
  expect(await fetchFile(t, address)).toMatchObject({
    ok: false,
    why: "unusable",
    note: "The file is too large.",
  });
});
