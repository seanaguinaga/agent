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
import type { Owner } from "../forms/sites";
import {
  browserKey,
  fakeNetwork,
  fakeReader,
  formPdf,
  kept,
  restoreNetwork,
  scanPdf,
  servePage,
  servePdf,
  serveStatus,
} from "../forms/network.testkit";
import {
  compilePacketForms,
  fileAt,
  locateForm,
  locateForms,
  newFinder,
} from "./locate";
import { scans, type T } from "./cases.testkit";

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
  scans.reader = undefined;
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

/** A test deployment whose register knows whose these domains are. */
async function withSites() {
  const t = initConvexTest();
  const row = (domain: string, owner: Owner, name = domain) => ({
    state: "vouched" as const,
    domain,
    name,
    owner,
    via: { kind: "register" as const, register: "cisa" as const },
  });
  const national = { level: "national" as const, country: "us" };
  await t.mutation(internal.easygov.forms.sites.putSites, {
    sites: [
      row("ssa.gov", national, "Social Security Administration"),
      row("gsa.gov", national),
      row("county.gov", {
        level: "local",
        country: "us",
        region: "us-ca",
        body: "county.gov",
      }),
      row("nv.gov", { level: "region", country: "us", region: "us-nv" }),
    ],
    at: 0,
  });
  return t;
}

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
  const t = await withSites();
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
  expect(located.file).toMatchObject({ url: leads[0], via: "given" });
  expect(located.failed).toMatchObject([
    { url: leads[1], why: "unspent" },
    { url: leads[2], why: "unspent" },
  ]);
});

test("an allowance spent on one form is spent for the packet's other forms too", async () => {
  const t = await withSites();
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
  expect(found.map(({ located }) => !!located.file?.editionId)).toEqual([
    true,
    false,
  ]);
});

test("a decision that can't be paid for isn't asked, and the other leads are still used", async () => {
  const t = await withSites();
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
  expect(located.file).toMatchObject({
    url: given,
    via: "given",
    backed: false,
  });
});

test("two entries for one form are looked up once and come back as one entry", async () => {
  const t = await withSites();
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
  expect(found[0].located.file).toMatchObject({ url: a, backed: true });
  // One lookup: one decision, and the page and each address asked once.
  expect(decideMock).toHaveBeenCalledTimes(1);
  expect(net.asked(index)).toBe(1);
  expect(net.asked(a)).toBe(1);
  expect(net.asked(b)).toBeLessThanOrEqual(1);
  expect((await kept(t)).editions).toHaveLength(1);
});

test("a title and a code that turn out to be one file are one entry, under the code", async () => {
  const t = await withSites();
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
  expect(found[0].located.file?.editionId).toBeDefined();
  // The third form's address is gone: it has an entry, and no file.
  expect(found[1].located).toMatchObject({
    failed: [{ url: `${ssa}/ssa-827.pdf`, why: "gone" }],
  });
  expect(found[1].located.file).toBeUndefined();
  expect(net.asked(a)).toBe(1);
  expect(net.asked(b)).toBe(1);
  const after = await kept(t);
  expect(after.editions).toHaveLength(1);
  expect(after.blobs).toHaveLength(1);
});

test("a form two ways of filing need is one lookup, and one entry for each way", async () => {
  const t = await withSites();
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

test("the authority's own link to a fillable English file is chosen over older editions others gave", async () => {
  const t = await withSites();
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
    file: {
      url: linked,
      via: "linked",
      backed: true,
      facts: { places: 1, language: "en", revision: 202508 },
    },
    designated: {
      url: linked,
      label: "English PDF",
      under: "Form SSA-561 | Request for Reconsideration",
      confidence: 0.9,
    },
    links: { onPages: 2, chose: "a link", further: 0 },
    others: [
      { url: earlier, via: "known", facts: { revision: 202103 } },
      { url: given, via: "given", facts: { revision: 201901 } },
    ],
  });
  // The decision was offered the page's words and heading for each link.
  expect(offered()[0].link1).toBe(
    'English PDF, under the heading "Form SSA-561 | Request for Reconsideration" [a file of Social Security Administration (www.ssa.gov): …/ssa-561.pdf, linked from a page of Social Security Administration (www.ssa.gov)]',
  );
  // The address research gave and the remembered one were asked too: either
  // could have been a later edition than the page links.
  expect(net.addresses()).toEqual([index, linked, given, earlier]);
  expect(finder.spend.spent).toMatchObject({
    // The stand-in server never answers "unchanged", so each is downloaded.
    downloads: 3,
    pages: 1,
    decisions: 1,
    refused: 0,
  });
});

test("a linked file with nowhere to write doesn't settle the form: the other leads are asked, and the fillable one is chosen", async () => {
  const t = await withSites();
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
    file: { url: given, via: "given", backed: false },
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

test("an unsure choice of link isn't taken as the authority's word: it is asked like any lead, and the choice is reported", async () => {
  const t = await withSites();
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

  // Asked as a guess: its file isn't confirmed by the link.
  expect(net.asked(linked)).toBe(1);
  expect(located.file).toMatchObject({
    url: given,
    via: "given",
    backed: false,
  });
  expect(located.designated).toBeUndefined();
  expect(located.links).toMatchObject({
    shortlisted: 1,
    chose: "none of the shortlist",
    considered: { confidence: 0.3 },
  });
});

// Rule 3 of "Finding a packet's forms": an address two forms lead to is
// requested once. The second form is answered from what the first kept.
test("an address two forms of one packet lead to is requested once", async () => {
  const t = await withSites();
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
  const t = await withSites();
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
  const t = await withSites();
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
  const t2 = await withSites();
  await fileAt(ctxOf(t2), other, asForm, lower);
  expect(await fileAt(ctxOf(t2), other, asForm, upper)).toMatchObject({
    ok: true,
  });
  expect(net.asked(upper)).toBe(1);
});

test("a refused request is tried through the browser, and with none set up the lead fails as busy", async () => {
  const t = await withSites();
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
  const t = await withSites();
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

  expect(located.file).toMatchObject({ url: a, via: "given" });
  expect(net.asked(a)).toBe(1);
  expect(finder.spend.spent).toMatchObject({
    downloads: 1,
    browser: 1,
    bytes: ssa561.length,
  });
});

test("a lead that turns out to be a page is read one link further on, without being requested again", async () => {
  const t = await withSites();
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
    file: { url: file, via: "linked", backed: true },
    designated: { url: file, further: true },
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
  const t = await withSites();
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
  expect(located.file).toBeUndefined();
  expect(located.designated).toBeUndefined();
  expect(located.links).toMatchObject({
    further: 1,
    chose: "none of the shortlist",
  });
  expect(decideMock).toHaveBeenCalledTimes(2);
});

test("the form's own page one link further on gives the file, and the link is the binding", async () => {
  const t = await withSites();
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
    file: { url: file, via: "linked", backed: true },
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
  const t = await withSites();
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

  expect(located.file).toMatchObject({
    url: file,
    via: "linked",
    backed: true,
  });
});

test("the file chosen is remembered, and is a lead for the next packet", async () => {
  const t = await withSites();
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

  expect(located.file).toMatchObject({ url: file, via: "known" });
  expect(net.asked(file)).toBe(2);
  expect(finder.spend.spent).toMatchObject({ downloads: 1 });
  expect((await kept(t)).editions).toHaveLength(1);
});

test("a form whose file can't be found again loses what was said of its old file", async () => {
  const t = await withSites();
  const gone = `${ssa}/ssa-561.pdf`;
  fakeNetwork({ [gone]: serveStatus(404) });
  // A draft built earlier, when the file was found and linked as the form.
  const earlier = {
    jurisdiction: "us",
    authority: subject.authority,
    packetForms: [
      { code: "SSA-561", sourceUrl: gone, inputs: [], backed: true },
    ],
  } as unknown as Parameters<typeof compilePacketForms>[2];

  const draft = await compilePacketForms(
    ctxOf(t),
    "thread",
    earlier,
    finderWith(),
  );

  expect(draft.packetForms).toEqual([
    expect.objectContaining({ code: "SSA-561", sourceUrl: "" }),
  ]);
  expect(draft.packetForms![0]).not.toHaveProperty("backed");
  // The draft it was given is left as it was.
  expect(earlier.packetForms![0]).toMatchObject({ backed: true });
});

test("a link confirms a file only where the page and the file are on the packet's government's own sites", async () => {
  const file = `${ssa}/ssa-561.pdf`;
  const copy = "https://www.county.gov/forms/ssa-561.pdf";
  const army = "https://armypubs.army.mil/pub/da-4187.pdf";
  const gsa = "https://www.gsa.gov/forms/sf-180.pdf";
  const nevada = "https://dmv.nv.gov/forms/dl-44.pdf";
  fakeNetwork({
    [file]: servePdf(ssa561),
    [copy]: servePdf(await formPdf(["Form SSA-561 (08-2025)", "County copy"])),
    [army]: servePdf(await formPdf(["DA Form 4187 (05-2014)"])),
    [gsa]: servePdf(await formPdf(["Standard Form SF-180 (04-2018)"])),
    [nevada]: servePdf(await formPdf(["Form DL-44 (01-2025)"])),
  });
  // Each on its own deployment, so no file found for one is known to the next.
  const located = async (
    url: string,
    on: string,
    code = "SSA-561",
    jurisdiction = "us",
  ) => {
    choosing(/./);
    const found = await locateForm(
      ctxOf(await withSites()),
      "thread",
      { code, leads: [] },
      // No authority is named: whose site it is comes from the register.
      { jurisdiction },
      finderWith(),
      { links: async () => [{ url, label: code, pdf: true, on }] },
    );
    return found.file;
  };

  expect(await located(file, index)).toMatchObject({ backed: true });
  // Another government's page linking the authority's file.
  expect(await located(file, "https://www.county.gov/")).toMatchObject({
    url: file,
    backed: false,
  });
  // The authority's page linking a copy on another site.
  expect(await located(copy, index)).toMatchObject({
    url: copy,
    backed: false,
  });
  // A military page and file, which the register doesn't list, are federal.
  expect(
    await located(army, "https://www.army.mil/forms", "DA 4187"),
  ).toMatchObject({ backed: true });
  // A sister agency's file: the national government is one owner.
  expect(await located(gsa, index, "SF-180")).toMatchObject({ backed: true });
  // A California form on Nevada's site, page and all.
  expect(
    await located(nevada, "https://dmv.nv.gov/forms/", "DL-44", "us/ca"),
  ).toMatchObject({ url: nevada, backed: false });
});

test("a site on a suffix governments share is judged whose it is: once, and from the packet's allowance", async () => {
  const page = "https://www.gov.uk/government/publications/sa100";
  const file = "https://assets.publishing.service.gov.uk/media/1/SA100.pdf";
  const net = fakeNetwork({
    [file]: servePdf(await formPdf(["Form SA100 (2026)"])),
    "https://www.gov.uk/": servePage("<title>GOV.UK</title>"),
  });
  const t = await withSites();
  decideMock.mockImplementation((async (
    _ctx: ActionCtx,
    question: { criteria: Offered },
  ) => ({
    choice: "national" in question.criteria ? "national" : "link1",
    confidence: 0.9,
  })) as never);
  const located = async (finder: ReturnType<typeof newFinder>) =>
    (
      await locateForm(
        ctxOf(t),
        "thread",
        { code: "SA100", leads: [] },
        { jurisdiction: "gb" },
        finder,
        {
          links: async () => [
            { url: file, label: "SA100", pdf: true, on: page },
          ],
        },
      )
    ).file;

  // With nothing to spend on it, the form is found and not confirmed.
  const poor = finderWith({ vouches: 0 });
  expect(await located(poor)).toMatchObject({ url: file, backed: false });
  expect(poor.spend.spent).toMatchObject({ vouches: 0, refused: 2 });
  expect(decideMock).toHaveBeenCalledTimes(1);

  // The page's site and the file's are each judged, with the page's words
  // for its link to the file, and the form is confirmed.
  const finder = finderWith();
  expect(await located(finder)).toMatchObject({ url: file, backed: true });
  expect(finder.spend.spent).toMatchObject({ vouches: 2, refused: 0 });
  expect(decideMock.mock.calls.map(([, { state }]) => state)).toEqual([
    expect.anything(),
    expect.anything(),
    { site: "www.gov.uk", title: "GOV.UK" },
    { site: "service.gov.uk", label: "SA100" },
  ]);
  expect(net.asked("https://www.gov.uk/")).toBe(1);

  // What was judged is kept: the next packet pays nothing, and asks nobody.
  const next = finderWith();
  expect(await located(next)).toMatchObject({ backed: true });
  expect(next.spend.spent.vouches).toBe(0);
  expect(decideMock).toHaveBeenCalledTimes(5);
});

test("a site the authority's page links is judged before the link is followed: only a vouched one is read further and confirms", async () => {
  const own = "https://forms.partner.org/ssa-561.html";
  const file = "https://forms.partner.org/ssa-561.pdf";
  const front = "https://forms.partner.org/";
  const located = async (verdict: "own" | "contractor") => {
    const net = fakeNetwork({
      [index]: servePage(`<a href="${own}">Form SSA-561</a>`),
      [front]: servePage(`<title>SSA forms</title><a href="${index}">SSA</a>`),
      [own]: servePage('<h1>Form SSA-561</h1><a href="ssa-561.pdf">PDF</a>'),
      [file]: servePdf(ssa561),
    });
    decideMock.mockImplementation((async (
      _ctx: ActionCtx,
      { criteria }: { criteria: Offered },
    ) => ({
      choice: "own" in criteria ? verdict : "link1",
      confidence: 0.9,
    })) as never);
    const finder = finderWith();
    const [found] = await locateForms(
      ctxOf(await withSites()),
      "thread",
      [{ code: "SSA-561", sourceUrl: "" }],
      subject,
      [index],
      finder,
    );
    return { file: found.located.file, net, spent: finder.spend.spent };
  };

  // It links the authority back, and the model says it is the authority's.
  const vouched = await located("own");
  expect(vouched.file).toMatchObject({ url: file, backed: true });
  expect(vouched.net.addresses()).toEqual([index, front, own, file]);
  expect(vouched.spent.vouches).toBe(1);
  // A vendor's: its page is read as one link from the authority's, and its
  // file, a link further, is never asked for.
  const vendor = await located("contractor");
  expect(vendor.file).toBeUndefined();
  expect(vendor.net.addresses()).toEqual([index, front, own]);
});

test("a file with no words to read is the form only on a very sure link, between the government's own sites, whose words name it", async () => {
  const file = `${ssa}/ssa-561.pdf`;
  const scan = await scanPdf();
  const located = async (confidence: number, on = index, label = "SSA-561") => {
    fakeNetwork({ [file]: servePdf(scan) });
    choosing(/ssa-561/, confidence);
    return await locateForm(
      ctxOf(await withSites()),
      "thread",
      { code: "SSA-561", leads: [file] },
      subject,
      finderWith(),
      { links: async () => [{ url: file, label, pdf: true, on }] },
    );
  };

  // Confirmed, and known as named by the link alone, with nothing read.
  const found = await located(0.9);
  expect(found.file).toMatchObject({
    url: file,
    via: "linked",
    backed: true,
    namedBy: "link",
    facts: { places: 0, language: "unknown" },
  });
  // Sure enough to follow, not to stand for the file.
  const unsure = await located(0.89);
  expect(unsure.file).toBeUndefined();
  expect(unsure.failed).toContainEqual(
    expect.objectContaining({ url: file, via: "linked", why: "otherForm" }),
  );
  // Another government's page, a site nobody vouches for, and a link whose
  // words don't name the form.
  expect((await located(1, "https://www.nv.gov/forms/")).file).toBeUndefined();
  expect((await located(1, "https://example.org/forms")).file).toBeUndefined();
  expect((await located(1, index, "Download PDF")).file).toBeUndefined();
});

test("a packet reads as many scans as its allowance, and a file with words of its own costs no read", async () => {
  const t = await withSites();
  const urls = [1, 2, 3].map((n) => `${ssa}/scan-${n}.pdf`);
  fakeNetwork({
    [urls[0]]: servePdf(await scanPdf(1)),
    [urls[1]]: servePdf(await scanPdf(2)),
    [urls[2]]: servePdf(ssa561),
  });
  const { model, sent } = await fakeReader("=====\nForm SSA-561 (08-2025)");
  scans.reader = model;
  const finder = finderWith({ reads: 1 });
  const ask = (url: string) =>
    fileAt(ctxOf(t), finder, { ...us, code: "SSA-561" }, url);

  expect(await ask(urls[2])).toMatchObject({ ok: true, namedBy: "text" });
  expect(finder.spend.spent.reads).toBe(0);
  expect(await ask(urls[0])).toMatchObject({ ok: true, namedBy: "ocr" });
  // The allowance is spent: the next scan goes unread, and is no form.
  expect(await ask(urls[1])).toMatchObject({ ok: false, why: "otherForm" });
  expect(finder.spend.spent.reads).toBe(1);
  expect(sent).toHaveLength(1);
  expect(newFinder().spend.take("reads")).toBe(true);
});

test("a form read from a scan ranks below one with words of its own, and the person is asked to check its edition", async () => {
  const scan = `${ssa}/ssa-561-scan.pdf`;
  const booklet = `${ssa}/ssa-561-notes.pdf`;
  const { model } = await fakeReader(
    "=====\nForm SSA-561 (08-2025) Use this form if you do not agree with the decision that is made on your claim and you are asking for the review of it.",
  );
  scans.reader = model;
  const sites = async () => {
    const scanned = servePdf(await scanPdf());
    fakeNetwork({
      // Served once the booklet is kept: the stand-in database can't keep
      // two files at the same moment.
      [scan]: async (asked) => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return scanned(asked);
      },
      [booklet]: servePdf(await formPdf(["Form SSA-561"], { field: false })),
    });
    return ctxOf(await withSites());
  };

  const found = await locateForm(
    await sites(),
    "thread",
    { code: "SSA-561", leads: [scan, booklet] },
    subject,
    finderWith({ decisions: 0 }),
  );
  expect(found.file).toMatchObject({ url: booklet, namedBy: "text" });
  expect(found.others).toMatchObject([{ url: scan }]);

  const draft = await compilePacketForms(
    await sites(),
    "thread",
    {
      jurisdiction: "us",
      authority: subject.authority,
      output: { sources: [] },
      packetForms: [{ code: "SSA-561", sourceUrl: scan, inputs: [] }],
    } as unknown as Parameters<typeof compilePacketForms>[2],
    finderWith({ decisions: 0 }),
  );
  expect(draft.packetForms).toMatchObject([
    {
      sourceUrl: scan,
      namedBy: "ocr",
      openItem: expect.stringMatching(
        /^Complete SSA-561 by hand\. EasyGov read this form from a scan.* current edition/,
      ),
    },
  ]);
});

test("a form named by its link alone is confirmed, never filled, and the person is told it couldn't be read", async () => {
  const t = await withSites();
  const file = `${ssa}/ssa-561.pdf`;
  fakeNetwork({
    [index]: servePage(`<h2>Form SSA-561</h2><a href="${file}">PDF</a>`),
    [file]: servePdf(await scanPdf()),
  });
  choosing(/ssa-561/, 0.95);

  const draft = await compilePacketForms(
    ctxOf(t),
    "thread",
    {
      jurisdiction: "us",
      authority: subject.authority,
      output: { sources: [index] },
      packetForms: [{ code: "SSA-561", sourceUrl: "", inputs: [] }],
    } as unknown as Parameters<typeof compilePacketForms>[2],
    finderWith(),
  );

  expect(draft.packetForms).toEqual([
    {
      code: "SSA-561",
      sourceUrl: file,
      inputs: [],
      backed: true,
      namedBy: "link",
      openItem: expect.stringMatching(
        /^Complete SSA-561 by hand\. EasyGov could not read the file .* links as this form/,
      ),
    },
  ]);
});

test("a later edition on the authority's own site is chosen over the old one its page links, and isn't confirmed", async () => {
  const t = await withSites();
  const old = `${ssa}/ssa-561-u2.pdf`;
  const current = `${ssa}/ssa-561.pdf`;
  const net = fakeNetwork({
    [old]: servePdf(await formPdf(["Form SSA-561-U2 (05-2016)"])),
    [current]: servePdf(ssa561),
  });
  choosing(/ssa-561-u2/);

  const located = await locateForm(
    ctxOf(t),
    "thread",
    { code: "SSA-561", leads: [current] },
    subject,
    finderWith(),
    {
      links: async () => [
        { url: old, label: "SSA-561", pdf: true, on: `${ssa}/ssa-3441.html` },
      ],
    },
  );

  expect(located.file).toMatchObject({
    url: current,
    via: "given",
    backed: false,
    facts: { revision: 202508 },
  });
  expect(net.asked(old)).toBe(1);
});

test("once the authority's own link gives a good file, leads off its sites aren't asked", async () => {
  const t = await withSites();
  const linked = `${ssa}/ssa-561.pdf`;
  const elsewhere = "https://www.county.gov/forms/ssa-561.pdf";
  const net = fakeNetwork({
    [linked]: servePdf(ssa561),
    [elsewhere]: servePdf(ssa561),
  });
  choosing(/ssa-561/);

  const located = await locateForm(
    ctxOf(t),
    "thread",
    { code: "SSA-561", leads: [elsewhere] },
    subject,
    finderWith(),
    {
      links: async () => [
        { url: linked, label: "SSA-561", pdf: true, on: index },
      ],
    },
  );

  expect(located.file).toMatchObject({ url: linked, backed: true });
  expect(net.asked(elsewhere)).toBe(0);
});
