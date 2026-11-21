// @vitest-environment node
// Binding a packet's forms to files, end to end: `locateForm` and
// `locateForms` over the real actions and tables, against a stand-in
// network. The decision model is replaced at its module, and no search is
// allowed, so no model is called.
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { internal } from "../../_generated/api";
import type { ActionCtx } from "../../_generated/server";
import { initConvexTest } from "../../setup.test";
import { decide } from "../decisions";
import {
  browserKey,
  fakeNetwork,
  formPdf,
  kept,
  restoreNetwork,
  servePage,
  servePdf,
  serveStatus,
} from "../forms/network.testkit";
import { fileAt, locateForm, locateForms, newFinder } from "./agents";
import type { T } from "./cases.testkit";

vi.mock("../../modelsForDemo", async () =>
  (await import("./cases.testkit")).mockModels(),
);
vi.mock("../decisions", () => ({ decide: vi.fn() }));
const decideMock = vi.mocked(decide);

const ssa = "https://www.ssa.gov/forms";
const index = `${ssa}/`;
const us = { jurisdiction: "us" };
const subject = { ...us, authority: "Social Security Administration" };

let ssa561: Uint8Array;
let ssa827: Uint8Array;
beforeAll(async () => {
  ssa561 = await formPdf([
    "Form SSA-561 (08-2025)",
    "Request for Reconsideration",
  ]);
  ssa827 = await formPdf(["Form SSA-827 (11-2024)"]);
});

let restoreKey: () => void;
beforeEach(() => {
  restoreKey = browserKey(undefined);
  decideMock.mockReset();
});
afterEach(() => {
  restoreKey();
  restoreNetwork();
});

/**
 * What the locate functions need of an action: a way to run the real
 * queries, mutations and actions. Nothing registered runs `locateForms`
 * alone, so the test stands in for the action that would.
 */
const ctxOf = (t: T) =>
  ({
    runQuery: t.query,
    runMutation: t.mutation,
    runAction: t.action,
  }) as unknown as ActionCtx;

/** A finder that may not search, so the search model is never called. */
const finderWith = (limits: Parameters<typeof newFinder>[0] = {}) =>
  newFinder({ searches: 0, ...limits });

/** The links a decision was asked to choose among, by their key. */
type Offered = Record<string, string>;

/**
 * Has the decision model choose the link whose description matches, as sure
 * as `confidence`; or none, if no link matches.
 */
function choosing(pattern: RegExp, confidence = 0.9) {
  decideMock.mockImplementation((async (
    _ctx: ActionCtx,
    question: { criteria: Offered },
  ) => {
    const [choice] = Object.entries(question.criteria).find(
      ([key, words]) => key !== "none" && pattern.test(words),
    ) ?? ["none"];
    return { choice, confidence };
  }) as never);
}

/** What each decision was offered, in order. */
const offered = () =>
  decideMock.mock.calls.map(
    ([, question]) => (question as { criteria: Offered }).criteria,
  );

test("a packet's allowance is never exceeded: what can't be paid for goes without and is counted", async () => {
  const t = initConvexTest();
  const leads = ["a", "b", "c"].map((name) => `${ssa}/${name}/ssa-561.pdf`);
  const net = fakeNetwork(
    Object.fromEntries(leads.map((url) => [url, servePdf(ssa561)])),
  );
  const finder = finderWith({ downloads: 1 });

  const located = await locateForm(
    ctxOf(t),
    "thread",
    { code: "SSA-561", leads },
    subject,
    finder,
  );

  // One address was asked; the other two were not requested at all.
  expect(net.requests.map(({ url }) => url)).toEqual([leads[0]]);
  expect(finder.spend.spent).toMatchObject({ downloads: 1, refused: 2 });
  expect(located).toMatchObject({ url: leads[0], via: "given" });
  expect(located.failed).toMatchObject([
    { url: leads[1], why: "unspent" },
    { url: leads[2], why: "unspent" },
  ]);
});

test("an allowance spent on one form is spent for the packet's other forms too", async () => {
  const t = initConvexTest();
  const [first, second] = [`${ssa}/ssa-561.pdf`, `${ssa}/ssa-827.pdf`];
  const net = fakeNetwork({
    [first]: servePdf(ssa561),
    [second]: servePdf(ssa827),
  });
  const finder = finderWith({ downloads: 1 });

  const found = await locateForms(
    ctxOf(t),
    "thread",
    [
      { code: "SSA-561", sourceUrl: first },
      { code: "SSA-827", sourceUrl: second },
    ],
    subject,
    [],
    finder,
  );

  expect(net.requests).toHaveLength(1);
  // Two went without: the second form's file, and the search for it.
  expect(finder.spend.spent).toMatchObject({ downloads: 1, refused: 2 });
  expect(found.map(({ located }) => !!located.editionId)).toEqual([
    true,
    false,
  ]);
});

test("a decision that can't be paid for isn't asked, and the other leads are still used", async () => {
  const t = initConvexTest();
  const given = `${ssa}/ssa-561.pdf`;
  fakeNetwork({
    [index]: servePage(`<a href="ssa-561.pdf">Form SSA-561</a>`),
    [given]: servePdf(ssa561),
  });
  const finder = finderWith({ decisions: 0 });

  const located = await locateForm(
    ctxOf(t),
    "thread",
    { code: "SSA-561", leads: [given] },
    subject,
    finder,
    { links: async () => [{ url: given, label: "Form SSA-561", pdf: true }] },
  );

  expect(decideMock).not.toHaveBeenCalled();
  expect(finder.spend.spent).toMatchObject({ decisions: 0, refused: 1 });
  expect(located).toMatchObject({ url: given, via: "given", backed: false });
});

test("two entries for one form are looked up once and come back as one entry", async () => {
  const t = initConvexTest();
  const [a, b] = [`${ssa}/ssa-561.pdf`, `${ssa}/SSA-561-U2.pdf`];
  const net = fakeNetwork({
    [index]: servePage(`<h2>Form SSA-561</h2><a href="ssa-561.pdf">PDF</a>`),
    [a]: servePdf(ssa561),
    [b]: servePdf(ssa561),
  });
  choosing(/ssa-561\.pdf/);
  const finder = finderWith();

  const found = await locateForms(
    ctxOf(t),
    "thread",
    [
      { code: "SSA-561", sourceUrl: a },
      { code: "Form SSA 561", sourceUrl: b },
    ],
    subject,
    [index],
    finder,
  );

  expect(found).toHaveLength(1);
  expect(found[0].form.code).toBe("SSA-561");
  expect(found[0].located).toMatchObject({ url: a, backed: true });
  // One lookup: one decision, and the page and each address asked once.
  expect(decideMock).toHaveBeenCalledTimes(1);
  expect(net.asked(index)).toBe(1);
  expect(net.asked(a)).toBe(1);
  expect(net.asked(b)).toBeLessThanOrEqual(1);
  expect((await kept(t)).editions).toHaveLength(1);
});

test("a title and a code that turn out to be one file are one entry, under the code", async () => {
  const t = initConvexTest();
  const [a, b] = [`${ssa}/reconsideration.pdf`, `${ssa}/ssa-561.pdf`];
  const net = fakeNetwork({ [a]: servePdf(ssa561), [b]: servePdf(ssa561) });
  // An earlier case kept the file. (Two addresses serving a file nobody has
  // kept yet, asked at once, is another matter: see `fetch.test.ts`.)
  await t.action(internal.easygov.forms.actions.fetchFile, {
    jurisdiction: "us",
    code: "SSA-561",
    url: b,
    way: "request",
    spend: true,
  });
  net.requests.length = 0;

  const found = await locateForms(
    ctxOf(t),
    "thread",
    [
      { code: "Request for Reconsideration", sourceUrl: a },
      { code: "SSA-561", sourceUrl: b },
      { code: "SSA-827", sourceUrl: `${ssa}/ssa-827.pdf` },
    ],
    subject,
    [],
    finderWith(),
  );

  expect(found.map(({ form }) => form.code)).toEqual(["SSA-561", "SSA-827"]);
  expect(found[0].located.editionId).toBeDefined();
  // The third form's address is gone: it has an entry, and no file.
  expect(found[1].located).toMatchObject({
    failed: [{ url: `${ssa}/ssa-827.pdf`, why: "gone" }],
  });
  expect(found[1].located.url).toBeUndefined();
  expect(net.asked(a)).toBe(1);
  expect(net.asked(b)).toBe(1);
  const after = await kept(t);
  expect(after.editions).toHaveLength(1);
  expect(after.blobs).toHaveLength(1);
});

test("a form two ways of filing need is one lookup, and one entry for each way", async () => {
  const t = initConvexTest();
  const a = `${ssa}/ssa-561.pdf`;
  const net = fakeNetwork({ [a]: servePdf(ssa561) });
  const mail = { key: "filingMethod", equals: "mail" };
  const office = { key: "filingMethod", equals: "in_person" };

  const found = await locateForms(
    ctxOf(t),
    "thread",
    [
      { code: "SSA-561", sourceUrl: a, when: mail },
      { code: "SSA-561", sourceUrl: a, when: office },
    ],
    subject,
    [],
    finderWith(),
  );

  expect(found.map(({ form }) => form.when?.equals)).toEqual([
    "mail",
    "in_person",
  ]);
  expect(found[0].located).toBe(found[1].located);
  expect(net.asked(a)).toBe(1);
});

test("the authority's own link to a fillable English file settles the form: no other lead is requested", async () => {
  const t = initConvexTest();
  const linked = `${ssa}/ssa-561.pdf`;
  const given = `${ssa}/old/ssa-561-2019.pdf`;
  const earlier = `${ssa}/archive/ssa-561.pdf`;
  const net = fakeNetwork({
    [index]: servePage(`<html><body>
      <h2>Form SSA-561 | Request for Reconsideration</h2>
      <a href="ssa-561.pdf">English PDF</a>
      <h2>Form SSA-827 | Authorization to Disclose Information</h2>
      <a href="ssa-827.pdf">English PDF</a>
    </body></html>`),
    [linked]: servePdf(ssa561),
    [given]: servePdf(await formPdf(["Form SSA-561 (01-2019)"])),
    [earlier]: servePdf(await formPdf(["Form SSA-561 (03-2021)"])),
  });
  // An earlier case chose another address for this form.
  const old = await t.action(internal.easygov.forms.actions.fetchFile, {
    jurisdiction: "us",
    code: "SSA-561",
    url: earlier,
    way: "request",
    spend: true,
  });
  if (!old.ok) throw new Error("The earlier file wasn't kept");
  await t.mutation(internal.easygov.forms.data.rememberChosen, {
    jurisdiction: "us",
    code: "SSA-561",
    url: earlier,
  });
  net.requests.length = 0;
  choosing(/Form SSA-561/);
  const finder = finderWith();

  const [{ located }] = await locateForms(
    ctxOf(t),
    "thread",
    [{ code: "SSA-561", sourceUrl: given }],
    subject,
    [index],
    finder,
  );

  expect(located).toMatchObject({
    url: linked,
    via: "linked",
    backed: true,
    facts: { places: 1, language: "en", revision: 202508 },
    designated: {
      url: linked,
      label: "English PDF",
      under: "Form SSA-561 | Request for Reconsideration",
      confidence: 0.9,
      by: "decision",
    },
    links: { onPages: 2, chose: "a link", further: 0 },
    others: [],
  });
  // The decision was offered the page's words and heading for each link.
  expect(offered()[0].link1).toBe(
    'English PDF, under the heading "Form SSA-561 | Request for Reconsideration" [www.ssa.gov/…/ssa-561.pdf, linked from a page of www.ssa.gov]',
  );
  // Neither the address research gave nor the remembered one was asked.
  expect(net.addresses()).toEqual([index, linked]);
  expect(finder.spend.spent).toMatchObject({
    downloads: 1,
    pages: 1,
    decisions: 1,
    refused: 0,
  });
});

test("a linked file with nowhere to write doesn't settle the form: the other leads are asked, and the fillable one is chosen", async () => {
  const t = initConvexTest();
  const linked = `${ssa}/ssa-561-print.pdf`;
  const given = `${ssa}/ssa-561.pdf`;
  const net = fakeNetwork({
    [index]: servePage(`<a href="ssa-561-print.pdf">Form SSA-561</a>`),
    [linked]: servePdf(
      await formPdf(["Form SSA-561 (08-2025) to print"], { field: false }),
    ),
    [given]: servePdf(ssa561),
  });
  choosing(/Form SSA-561/);

  const located = await locateForm(
    ctxOf(t),
    "thread",
    { code: "SSA-561", leads: [given] },
    subject,
    finderWith(),
    { links: () => readIndex(t) },
  );

  expect(net.asked(linked)).toBe(1);
  expect(net.asked(given)).toBe(1);
  expect(located).toMatchObject({
    url: given,
    via: "given",
    backed: false,
    designated: { url: linked },
    others: [{ url: linked, via: "linked" }],
  });
});

/** The links on the index page, read through the real action. */
async function readIndex(t: T) {
  const answer = await t.action(internal.easygov.forms.actions.readLinks, {
    url: index,
    way: "request",
    spend: true,
  });
  return answer.ok ? answer.links : [];
}

test("an unsure choice of link isn't acted on: the other leads are used and the choice is reported", async () => {
  const t = initConvexTest();
  const linked = `${ssa}/ssa-561-sp.pdf`;
  const given = `${ssa}/ssa-561.pdf`;
  const net = fakeNetwork({
    [index]: servePage(`<a href="ssa-561-sp.pdf">SSA-561 (Spanish)</a>`),
    [linked]: servePdf(ssa561),
    [given]: servePdf(ssa561),
  });
  choosing(/SSA-561/, 0.3);

  const located = await locateForm(
    ctxOf(t),
    "thread",
    { code: "SSA-561", leads: [given] },
    subject,
    finderWith(),
    { links: () => readIndex(t) },
  );

  expect(net.asked(linked)).toBe(0);
  expect(located).toMatchObject({ url: given, via: "given", backed: false });
  expect(located.designated).toBeUndefined();
  expect(located.links).toMatchObject({
    shortlisted: 1,
    chose: "none of the shortlist",
    considered: { confidence: 0.3 },
  });
});

// A bug, left failing on purpose. `fileAt` remembers what it asked under the
// address AND the form's code (`exact` and `loose` in `case/agents.ts`), so
// an address that two forms of one packet lead to is requested once for
// each form: here a second request, where rule 3 of "Finding a packet's
// forms" says an address is asked once in a packet. Remove `.fails` when
// the second form is answered from the first form's ask.
test("an address two forms of one packet lead to is requested once", async () => {
  const t = initConvexTest();
  // One file holds both forms, and each form has it as a lead.
  const both = `${ssa}/ssa-561.pdf`;
  const net = fakeNetwork({
    [both]: servePdf(
      await formPdf(["Form SSA-561 (08-2025)", "Form SSA-827 (11-2024)"]),
    ),
  });
  const finder = finderWith();
  const ctx = ctxOf(t);

  const first = await fileAt(ctx, finder, { ...us, code: "SSA-561" }, both);
  const second = await fileAt(ctx, finder, { ...us, code: "SSA-827" }, both);

  expect(first.ok && second.ok).toBe(true);
  expect(net.asked(both)).toBe(1);
  expect(finder.spend.spent.downloads).toBe(1);
});

test("an address asked twice for one form in a packet is requested once, whatever the host's letter case", async () => {
  const t = initConvexTest();
  const a = `${ssa}/ssa-561.pdf`;
  const net = fakeNetwork({ [a]: servePdf(ssa561) });
  const finder = finderWith();
  const asForm = { ...us, code: "SSA-561" };

  const answers = await Promise.all([
    fileAt(ctxOf(t), finder, asForm, a),
    fileAt(ctxOf(t), finder, asForm, "https://WWW.SSA.GOV/forms/ssa-561.pdf"),
    fileAt(ctxOf(t), finder, asForm, `${a}#page=2`),
  ]);

  expect(answers.every((answer) => answer.ok)).toBe(true);
  expect(net.requests).toHaveLength(1);
  expect(finder.spend.spent.downloads).toBe(1);
});

test("an address that differs only in the path's letter case is asked only if the first served no file", async () => {
  const t = initConvexTest();
  const [lower, upper] = [`${ssa}/ssa-561.pdf`, `${ssa}/SSA-561.pdf`];
  const net = fakeNetwork({
    [lower]: servePdf(ssa561),
    [upper]: servePdf(ssa561),
  });
  const finder = finderWith();
  const asForm = { ...us, code: "SSA-561" };

  await fileAt(ctxOf(t), finder, asForm, lower);
  expect(await fileAt(ctxOf(t), finder, asForm, upper)).toMatchObject({
    ok: true,
  });
  expect(net.asked(upper)).toBe(0);

  // Where the first spelling is gone, the second is asked.
  const other = finderWith();
  net.routes[lower] = serveStatus(404);
  const t2 = initConvexTest();
  await fileAt(ctxOf(t2), other, asForm, lower);
  expect(await fileAt(ctxOf(t2), other, asForm, upper)).toMatchObject({
    ok: true,
  });
  expect(net.asked(upper)).toBe(1);
});

test("a refused request is tried through the browser, and with none set up the lead fails as busy", async () => {
  const t = initConvexTest();
  const a = `${ssa}/ssa-561.pdf`;
  const net = fakeNetwork({ [a]: serveStatus(403) });
  const finder = finderWith();

  const located = await locateForm(
    ctxOf(t),
    "thread",
    { code: "SSA-561", leads: [a] },
    subject,
    finder,
  );

  expect(located.failed).toMatchObject([{ url: a, why: "busy" }]);
  expect(net.asked(a)).toBe(1);
  expect(net.service).toHaveLength(0);
  // The browser that wasn't used isn't paid for.
  expect(finder.spend.spent).toMatchObject({ downloads: 1, browser: 0 });
  expect((await kept(t)).addresses).toHaveLength(0);
});

test("a refused request is collected through the browser when one is set up", async () => {
  restoreKey();
  restoreKey = browserKey("key");
  const t = initConvexTest();
  const a = `${ssa}/ssa-561.pdf`;
  const net = fakeNetwork({ [a]: serveStatus(403) }, { download: ssa561 });
  const finder = finderWith();

  const located = await locateForm(
    ctxOf(t),
    "thread",
    { code: "SSA-561", leads: [a] },
    subject,
    finder,
  );

  expect(located).toMatchObject({ url: a, via: "given" });
  expect(net.asked(a)).toBe(1);
  expect(finder.spend.spent).toMatchObject({
    downloads: 1,
    browser: 1,
    bytes: ssa561.length,
  });
});

test("a lead that turns out to be a page is read one link further on, without being requested again", async () => {
  const t = initConvexTest();
  const page = `${ssa}/ssa-561.html`;
  const file = `${ssa}/ssa-561.pdf`;
  const net = fakeNetwork({
    [page]: servePage(`<!doctype html><html><body>
      <h1>Form SSA-561 | Request for Reconsideration</h1>
      <a href="ssa-561.pdf">Download PDF</a>
    </body></html>`),
    [file]: servePdf(ssa561),
  });
  choosing(/ssa-561\.pdf/);
  const finder = finderWith();

  const located = await locateForm(
    ctxOf(t),
    "thread",
    { code: "SSA-561", leads: [page] },
    subject,
    finder,
  );

  expect(located).toMatchObject({
    url: file,
    via: "linked",
    backed: true,
    designated: { url: file, further: true, by: "decision" },
    links: { onPages: 0, further: 1, chose: "a link" },
    failed: [{ url: page, why: "page" }],
  });
  expect(net.asked(page)).toBe(1);
  expect(net.asked(file)).toBe(1);
  expect(finder.spend.spent).toMatchObject({
    downloads: 2,
    pages: 0,
    reused: 1,
  });
});

test("the link chosen is followed one page further, and no further", async () => {
  const t = initConvexTest();
  const further = ["a", "b", "c"].map((name) => `${ssa}/ssa-561-${name}.html`);
  const deeper = `${ssa}/ssa-561-deeper.html`;
  const file = `${ssa}/ssa-561.pdf`;
  const net = fakeNetwork({
    // The page research read links no file, only pages that name the
    // form.
    [index]: servePage(`<html><body>
      <a href="ssa-561-a.html">Form SSA-561</a>
      <a href="ssa-561-b.html">About form SSA-561</a>
      <a href="ssa-561-c.html">Help with SSA-561</a>
      <a href="ssa-827.html">Form SSA-827</a>
    </body></html>`),
    // Neither of the first two links the file: one points a level deeper.
    [further[0]]: servePage(
      `<html><a href="ssa-561-deeper.html">SSA-561, continued</a></html>`,
    ),
    [further[1]]: servePage(`<html><p>Nothing here.</p></html>`),
    // The third page and the deeper one both link the file.
    [further[2]]: servePage(`<html><a href="ssa-561.pdf">SSA-561</a></html>`),
    [deeper]: servePage(`<html><a href="ssa-561.pdf">SSA-561</a></html>`),
    [file]: servePdf(ssa561),
  });
  choosing(/SSA-561/);
  const finder = finderWith();

  const [{ located }] = await locateForms(
    ctxOf(t),
    "thread",
    [{ code: "SSA-561", sourceUrl: "" }],
    subject,
    [index],
    finder,
  );

  // The link chosen is asked and is a page; the link chosen on that page is
  // asked and is a page too, and there it stops: the file that page links
  // is never asked for, nor are the pages that weren't chosen.
  expect(net.addresses()).toEqual([index, further[0], deeper]);
  expect(net.asked(further[1])).toBe(0);
  expect(net.asked(further[2])).toBe(0);
  expect(net.asked(file)).toBe(0);
  expect(located.url).toBeUndefined();
  expect(located.designated).toBeUndefined();
  expect(located.links).toMatchObject({
    further: 1,
    chose: "none of the shortlist",
  });
  expect(decideMock).toHaveBeenCalledTimes(2);
});

test("the form's own page one link further on gives the file, and the link is the binding", async () => {
  const t = initConvexTest();
  const own = `${ssa}/ssa-561.html`;
  const file = `${ssa}/ssa-561.pdf`;
  const net = fakeNetwork({
    [index]: servePage(`<html><body>
      <a href="ssa-561.html">Form SSA-561 | Request for Reconsideration</a>
      <a href="ssa-827.html">Form SSA-827</a>
    </body></html>`),
    [own]: servePage(`<html><body>
      <h1>Form SSA-561 | Request for Reconsideration</h1>
      <a href="ssa-561.pdf">Download PDF</a>
      <a href="ssa-561-sp.pdf">Descargar PDF</a>
    </body></html>`),
    [file]: servePdf(ssa561),
  });
  // First the form's own page is chosen, then the file on it.
  choosing(/Form SSA-561 \||Download PDF/);

  const [{ located }] = await locateForms(
    ctxOf(t),
    "thread",
    [{ code: "SSA-561", sourceUrl: "" }],
    subject,
    [index],
    finderWith(),
  );

  expect(net.addresses()).toEqual([index, own, file]);
  expect(located).toMatchObject({
    url: file,
    via: "linked",
    backed: true,
    designated: {
      url: file,
      label: "Download PDF",
      under: "Form SSA-561 | Request for Reconsideration",
      further: true,
    },
    links: { further: 1, chose: "a link" },
  });
});

test("a renamed form is found through the page's words for its link", async () => {
  const t = initConvexTest();
  const file = `${ssa}/ssa-561.pdf`;
  fakeNetwork({
    [index]: servePage(`<html><body>
      <h2>Form SSA-561 | Request for Reconsideration</h2>
      <a href="ssa-561.pdf">English PDF</a>
    </body></html>`),
    [file]: servePdf(ssa561),
  });
  choosing(/ssa-561\.pdf/);

  // Research still calls the form by its old name, and gave the same file.
  const [{ located }] = await locateForms(
    ctxOf(t),
    "thread",
    [{ code: "SSA-561-U2", sourceUrl: file }],
    subject,
    [index],
    finderWith(),
  );

  expect(located).toMatchObject({ url: file, via: "linked", backed: true });
});

test("the file chosen is remembered, and is a lead for the next packet", async () => {
  const t = initConvexTest();
  const file = `${ssa}/ssa-561.pdf`;
  const net = fakeNetwork({ [file]: servePdf(ssa561) });
  await locateForm(
    ctxOf(t),
    "thread",
    { code: "SSA-561", leads: [file] },
    subject,
    finderWith(),
  );

  // The next case's research gives no address for the form at all.
  const finder = finderWith();
  const located = await locateForm(
    ctxOf(t),
    "thread",
    { code: "Form SSA-561", leads: [] },
    subject,
    finder,
  );

  expect(located).toMatchObject({ url: file, via: "known" });
  expect(net.asked(file)).toBe(2);
  expect(finder.spend.spent).toMatchObject({ downloads: 1 });
  expect((await kept(t)).editions).toHaveLength(1);
});
