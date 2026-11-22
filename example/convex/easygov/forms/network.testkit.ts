// Shared by the tests of finding a form: a stand-in for the network (the
// authority's sites and the hosted browser service), and small real PDFs to
// serve from it. The extra dot keeps Convex from deploying this file.
import {
  PDFBool,
  PDFDocument,
  PDFName,
  PDFString,
  StandardFonts,
} from "pdf-lib";
import { vi } from "vitest";
import type { T } from "../case/cases.testkit";

/** One request the code under test made. */
export type Asked = { url: string; method: string; headers: Headers };

/** What an address answers a request with. */
export type Served = (asked: Asked) => Response | Promise<Response>;

const BROWSER_API = "https://api.browserbase.com/v1";

/** What the hosted browser service does, for the tests that reach it. */
export type FakeBrowser = {
  /** The status every request for a session is answered with. Default 200. */
  sessions?: number;
  /** The file the browser downloads, if it downloads one. */
  download?: Uint8Array;
  /**
   * The page the browser shows, if it shows one, and where it ends up.
   * `scripted` is what its scripts then put in an open shadow root, a piece
   * each time the page is looked at: seen only by a read of shadow roots.
   */
  page?: { html: string; at: string; scripted?: string[] };
};

/**
 * Replaces the global `fetch` with a set of addresses that answer as told.
 * An address that isn't listed answers 404. Every request is kept, so a test
 * can say what was asked, how often, and with which headers.
 */
export function fakeNetwork(
  routes: Record<string, Served>,
  browser: FakeBrowser = {},
) {
  const requests: Asked[] = [];
  const service: Asked[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url =
      typeof input === "string" || input instanceof URL
        ? String(input)
        : input.url;
    const asked = {
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
    };
    if (url.startsWith(BROWSER_API)) {
      service.push(asked);
      const path = url.slice(BROWSER_API.length);
      if (path === "/sessions") {
        return browser.sessions && browser.sessions !== 200
          ? new Response(null, { status: browser.sessions })
          : Response.json({ id: "s1", connectUrl: "wss://browser.test/s1" });
      }
      if (path.startsWith("/downloads?")) {
        return Response.json({
          downloads: browser.download
            ? [
                {
                  id: "d1",
                  mimeType: "application/pdf",
                  size: browser.download.length,
                },
              ]
            : [],
        });
      }
      if (path === "/downloads/d1" && browser.download) {
        return new Response(browser.download.slice().buffer);
      }
      return Response.json({});
    }
    requests.push(asked);
    const serve = routes[url];
    return serve ? await serve(asked) : new Response(null, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("WebSocket", browserSocket(browser));
  return {
    routes,
    /** Requests to the authority's sites, in order. */
    requests,
    /** Requests to the hosted browser service, in order. */
    service,
    /** How many times an address was requested. */
    asked: (url: string) => requests.filter((each) => each.url === url).length,
    /** The addresses requested, each once, in the order first asked. */
    addresses: () => [...new Set(requests.map(({ url }) => url))],
  };
}

/**
 * A browser connection that opens, answers each command, and shows
 * `browser.page` once asked what is loaded: a blank tab if there is none.
 */
function browserSocket({ page }: FakeBrowser) {
  /** How many pieces the page's scripts have built so far. */
  let built = 0;
  const shadow = () => (page?.scripted ?? []).slice(0, built).join("");
  const links = (html: string) => html.match(/<a\b/g)?.length ?? 0;
  /** What an expression evaluates to in the page. */
  const evaluate = (expression: string) => {
    const deep = expression.includes("shadowRoot");
    if (expression.startsWith("JSON.stringify")) {
      if (!page)
        return JSON.stringify(["about:blank", "complete", "text/html"]);
      const count = links(page.html) + (deep ? links(shadow()) : 0);
      built++;
      return JSON.stringify([page.at, "complete", "text/html", count]);
    }
    return page && deep && shadow()
      ? `${page.html}<template shadowrootmode="open">${shadow()}</template>`
      : page?.html;
  };
  return class {
    private listeners: Record<string, ((event: { data?: string }) => void)[]> =
      {};
    constructor(public url: string) {
      setTimeout(() => this.emit("open", {}), 0);
    }
    addEventListener(
      type: string,
      listener: (event: { data?: string }) => void,
    ) {
      (this.listeners[type] ??= []).push(listener);
    }
    private emit(type: string, event: { data?: string }) {
      for (const listener of this.listeners[type] ?? []) listener(event);
    }
    send(raw: string) {
      const { id, method, params } = JSON.parse(raw) as {
        id: number;
        method: string;
        params: { expression?: string };
      };
      const value = params.expression && evaluate(params.expression);
      const result =
        method === "Target.createTarget"
          ? { targetId: "t1" }
          : method === "Target.attachToTarget"
            ? { sessionId: "p1" }
            : { result: { value } };
      setTimeout(
        () => this.emit("message", { data: JSON.stringify({ id, result }) }),
        0,
      );
    }
    close() {}
  };
}

/** Undoes `fakeNetwork`. Call from `afterEach`. */
export function restoreNetwork() {
  vi.unstubAllGlobals();
  vi.useRealTimers();
}

/**
 * Sets or unsets the hosted browser's key for one test, and returns what puts
 * it back as it was.
 */
export function browserKey(key: string | undefined) {
  const before = process.env.BROWSERBASE_API_KEY;
  if (key === undefined) delete process.env.BROWSERBASE_API_KEY;
  else process.env.BROWSERBASE_API_KEY = key;
  return () => {
    if (before === undefined) delete process.env.BROWSERBASE_API_KEY;
    else process.env.BROWSERBASE_API_KEY = before;
  };
}

/**
 * Waits for work that sleeps (a busy browser service, a download that never
 * comes) without waiting in real time. Needs `vi.useFakeTimers()` first.
 */
export async function withoutWaiting<R>(work: Promise<R>): Promise<R> {
  let settled = false;
  const done = () => {
    settled = true;
  };
  work.then(done, done);
  for (let turns = 0; !settled && turns < 600; turns++) {
    await vi.advanceTimersByTimeAsync(500);
  }
  return await work;
}

/** A PDF served as a file, with whatever headers the server adds. */
export const servePdf =
  (bytes: Uint8Array, headers: Record<string, string> = {}): Served =>
  () =>
    new Response(bytes.slice().buffer, {
      headers: { "content-type": "application/pdf", ...headers },
    });

/**
 * A PDF served by a server that says when it hasn't changed: it answers 304
 * to a request that carries the validators it gave out.
 */
export const serveRevalidating =
  (bytes: Uint8Array, etag: string, lastModified: string): Served =>
  ({ headers }) =>
    headers.get("if-none-match") === etag ||
    headers.get("if-modified-since") === lastModified
      ? new Response(null, { status: 304 })
      : new Response(bytes.slice().buffer, {
          headers: {
            "content-type": "application/pdf",
            etag,
            "last-modified": lastModified,
          },
        });

/** A web page. */
export const servePage =
  (html: string): Served =>
  () =>
    new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });

/** Nothing but a status. */
export const serveStatus =
  (status: number): Served =>
  () =>
    new Response(null, { status });

/** Enough plain English for a file's language to be told. */
const ENGLISH = [
  "Use this form if you do not agree with the decision that is made on your",
  "claim and you are asking for the review of it. Print your name and the",
  "address for your home with the number of the claim, and sign this form.",
];

/**
 * A small real PDF: one page that prints `lines` and, unless `field` is
 * false, has one place to write in.
 */
export async function formPdf(
  lines: string[],
  { field = true, english = true } = {},
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  [...lines, ...(english ? ENGLISH : [])].forEach((line, i) =>
    page.drawText(line, { x: 48, y: 740 - i * 18, size: 10, font }),
  );
  if (field) {
    doc
      .getForm()
      .createTextField("name")
      .addToPage(page, { x: 48, y: 500, width: 300, height: 18 });
  }
  return await doc.save();
}

/**
 * A small real XFA form, as Adobe's designer saves one: its one page says
 * only "Please wait...", and `lines` are in the XFA template, with no field
 * a PDF reader could fill.
 */
export async function xfaPdf(lines: string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([612, 792]).drawText("Please wait...", { x: 48, y: 740, font });
  const draws = [...lines, ...ENGLISH].map(
    (line, i) =>
      `<draw y="${i * 6}mm" w="180mm" h="6mm"><value><text>${line}</text></value></draw>`,
  );
  const packets = {
    "xdp:xdp": '<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/">',
    template:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform>' +
      '<pageSet><pageArea><contentArea w="190mm" h="270mm"/></pageArea></pageSet>' +
      `<subform w="190mm" h="270mm">${draws.join("")}</subform></subform></template>`,
    datasets:
      '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data/></xfa:datasets>',
    "/xdp:xdp": "</xdp:xdp>",
  };
  const { context, catalog } = doc;
  catalog.set(PDFName.of("NeedsRendering"), PDFBool.True);
  catalog.set(
    PDFName.of("AcroForm"),
    context.obj({
      XFA: Object.entries(packets).flatMap(([name, xml]) => [
        PDFString.of(name),
        context.register(context.stream(xml)),
      ]),
    }),
  );
  return await doc.save();
}

/** The rows kept, to say what finding a form stored. */
export const kept = (t: T) =>
  t.run(async (ctx) => {
    const addresses = await ctx.db.query("formAddresses").collect();
    return {
      editions: await ctx.db.query("formEditions").collect(),
      addresses,
      pages: addresses.filter(({ outcome }) => outcome === "page"),
      blobs: await ctx.db.system.query("_storage").collect(),
    };
  });
