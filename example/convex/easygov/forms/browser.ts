"use node";
// Opening an address in a real, hosted browser and collecting the file it
// downloads. For the authority's sites that a plain request can't read: a
// link that needs a browser to follow, a download that starts from a page.
//
// This talks to Browserbase directly: create a session, tell it to open the
// address, and collect the download. That's all a browser is needed for
// here, so there's no automation library and no model.
//
// Matches EasyGov's source browser: managed proxies, CAPTCHA solving and
// ad blocking. A site that still refuses access is reported as unreachable.

import { MAX_BYTES, readUpTo } from "./sources";

const API = "https://api.browserbase.com/v1";

export type BrowserService = {
  apiKey: string;
  projectId?: string;
  /** How long to wait for the download, and how often to look. */
  timeoutMs?: number;
  pollMs?: number;
  /** How long to wait before asking again when the service is busy. */
  busyWaitMs?: number;
  /** For tests. */
  fetch?: typeof fetch;
  WebSocket?: typeof WebSocket;
};

type Download = { id: string; mimeType: string; size: number };

/**
 * The service has no browser to give right now: too many are open, or too
 * many were asked for at once. Nothing was learned about the address.
 */
export class BrowserBusy extends Error {}

/** The browser service from the environment, if its keys are set. */
export function browserService(): BrowserService | undefined {
  const apiKey = process.env.BROWSERBASE_API_KEY;
  if (!apiKey) return undefined;
  return { apiKey, projectId: process.env.BROWSERBASE_PROJECT_ID };
}

/** What a browser session gives the work done in it. */
type Session = {
  id: string;
  socket: WebSocket;
  headers: Record<string, string>;
  request: typeof fetch;
  /**
   * Waits for one step, no longer than `ms`. `doing` is what the step is,
   * so a stall says which step stalled.
   */
  step: <T>(doing: string, wait: Promise<T>, ms: number) => Promise<T>;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Starts a hosted browser, runs `work` in it, and lets the browser go
 * whatever happens. Nothing here waits without a limit: starting, connecting
 * and releasing each have one, and `work` gets `step` to put one on each of
 * its own waits. A busy service is asked twice more, a little later each
 * time, then reported as busy.
 */
async function inBrowser<T>(
  service: BrowserService,
  work: (session: Session) => Promise<T>,
): Promise<T> {
  const { apiKey, projectId, busyWaitMs = 3_000 } = service;
  const request = service.fetch ?? fetch;
  const Socket = service.WebSocket ?? WebSocket;
  const headers = {
    "X-BB-API-Key": apiKey,
    "Content-Type": "application/json",
  };
  const step: Session["step"] = (doing, wait, ms) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`The browser stalled while ${doing}.`)),
        ms,
      );
      wait.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });

  let session: { id: string; connectUrl: string } | undefined;
  for (let tries = 0; !session; tries++) {
    const created = await step(
      "starting a browser",
      request(`${API}/sessions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          ...(projectId && { projectId }),
          browserSettings: { blockAds: true, solveCaptchas: true },
          proxies: true,
          timeout: 90,
        }),
      }),
      20_000,
    );
    if (created.status === 429) {
      if (tries >= 2) {
        throw new BrowserBusy("The browser service answered 429.");
      }
      await sleep(busyWaitMs * (tries + 1));
      continue;
    }
    if (!created.ok) {
      throw new Error(`The browser service answered ${created.status}.`);
    }
    session = await step(
      "starting a browser",
      created.json() as Promise<{ id: string; connectUrl: string }>,
      10_000,
    );
  }

  let socket: WebSocket | undefined;
  try {
    socket = new Socket(session.connectUrl);
    const open = socket;
    await step(
      "connecting to the browser",
      new Promise<void>((resolve, reject) => {
        const failed = () =>
          reject(new Error("Couldn't connect to the browser."));
        open.addEventListener("open", () => resolve(), { once: true });
        open.addEventListener("error", failed, { once: true });
        // A connection can close without ever saying it failed.
        open.addEventListener("close", failed, { once: true });
      }),
      20_000,
    );
    return await work({ id: session.id, socket: open, headers, request, step });
  } finally {
    socket?.close();
    // Don't leave a browser running on the account.
    await step(
      "releasing the browser",
      request(`${API}/sessions/${encodeURIComponent(session.id)}`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          ...(projectId && { projectId }),
          status: "REQUEST_RELEASE",
        }),
      }),
      10_000,
    ).catch(() => undefined);
  }
}

/** What an address opened in a browser gave: a file it downloaded, or a page. */
export type Opened =
  | { got: "file"; bytes: Uint8Array }
  /** `at` is where the page ended up, after any redirects. */
  | { got: "page"; html: string; at: string };

/** What the browser answers a command with, or why it refused. */
type Reply = { id?: number; result?: unknown; error?: { message?: string } };

/**
 * Sends commands to the browser and waits for each one's answer, under its
 * own number, no later than `deadline` (and never more than 15 seconds).
 */
function commander(socket: WebSocket, deadline: number) {
  let next = 1;
  const waiting = new Map<
    number,
    { resolve: (result: unknown) => void; reject: (error: Error) => void }
  >();
  socket.addEventListener("message", (event) => {
    let reply: Reply;
    try {
      reply = JSON.parse(String(event.data)) as Reply;
    } catch {
      return;
    }
    const pending = reply.id === undefined ? undefined : waiting.get(reply.id);
    if (!pending || reply.id === undefined) return;
    waiting.delete(reply.id);
    if (reply.error) {
      pending.reject(
        new Error(reply.error.message ?? "The browser refused a command."),
      );
    } else {
      pending.resolve(reply.result ?? {});
    }
  });
  return <T>(
    method: string,
    params: Record<string, unknown>,
    sessionId?: string,
  ) =>
    new Promise<T>((resolve, reject) => {
      const id = next++;
      const timer = setTimeout(
        () => {
          waiting.delete(id);
          reject(new Error("The browser didn't answer in time."));
        },
        Math.min(15_000, Math.max(1_000, deadline - Date.now())),
      );
      waiting.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      socket.send(
        JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }),
      );
    });
}

/** Every open shadow root in the page, however deep. Closed ones stay shut. */
const ROOTS = `(() => {
  const roots = [];
  const within = (node) => {
    for (const element of node.querySelectorAll("*")) {
      if (element.shadowRoot) {
        roots.push(element.shadowRoot);
        within(element.shadowRoot);
      }
    }
  };
  within(document);
  return roots;
})()`;

/** Where the page is, whether it has loaded, and how many links it has. */
const STATE = `JSON.stringify([location.href, document.readyState, document.contentType, [document, ...${ROOTS}].reduce((count, root) => count + root.querySelectorAll("a[href]").length, 0)])`;

/** The page as it stands, with what its scripts put in open shadow roots. */
const HTML = `document.documentElement.getHTML({ serializableShadowRoots: true, shadowRoots: ${ROOTS} })`;

/**
 * Opens `url` in a hosted browser: what it downloads, if it downloads a
 * file, or else the page it shows, and where that is. A page is taken once
 * it has loaded and its scripts have stopped adding links: it has as many
 * on two looks running, or the time is up. So an address is asked once,
 * whichever it turns out to be. Throws if it gives neither, and never waits
 * long: every step has a limit, and a stall says which step.
 */
export async function openViaBrowser(
  url: string,
  service: BrowserService,
): Promise<Opened> {
  const { timeoutMs = 45_000, pollMs = 2_000 } = service;
  return await inBrowser(
    service,
    async ({ id, socket, headers, request, step }) => {
      const deadline = Date.now() + timeoutMs;
      const call = commander(socket, deadline);
      // Keep what it downloads where the service can hand it back.
      await call("Browser.setDownloadBehavior", {
        behavior: "allow",
        downloadPath: "downloads",
        eventsEnabled: true,
      });
      const { targetId } = await call<{ targetId: string }>(
        "Target.createTarget",
        { url },
      );
      const { sessionId } = await call<{ sessionId: string }>(
        "Target.attachToTarget",
        { targetId, flatten: true },
      );
      const evaluate = async (expression: string) =>
        (
          await call<{ result?: { value?: unknown } }>(
            "Runtime.evaluate",
            { expression, returnByValue: true },
            sessionId,
          )
        ).result?.value;

      /** What the page said when last looked at, if it had loaded. */
      let before: string | undefined;
      for (;;) {
        const listed = await step(
          "looking for the download",
          request(
            `${API}/downloads?${new URLSearchParams({ sessionId: id, limit: "1" })}`,
            { headers },
          ),
          15_000,
        );
        if (!listed.ok) {
          throw new Error(`Listing downloads answered ${listed.status}.`);
        }
        const { downloads = [] } = await step(
          "looking for the download",
          listed.json() as Promise<{ downloads?: Download[] }>,
          10_000,
        );
        const [download] = downloads;
        if (download) {
          const file = await step(
            "collecting the download",
            request(`${API}/downloads/${encodeURIComponent(download.id)}`, {
              headers: { ...headers, Accept: "application/octet-stream" },
            }),
            30_000,
          );
          if (!file.ok) {
            throw new Error(`Fetching the download answered ${file.status}.`);
          }
          const { bytes, cut } = await step(
            "collecting the download",
            readUpTo(file, MAX_BYTES),
            30_000,
          );
          if (cut) throw new Error("The file is too large.");
          return { got: "file", bytes };
        }
        // A new tab starts as a blank page that already counts as loaded:
        // a page is taken once it is somewhere, and has finished loading.
        const state = await evaluate(STATE).catch(() => undefined);
        const [at, ready, type] =
          typeof state === "string"
            ? (JSON.parse(state) as string[])
            : ["", "", ""];
        const loaded =
          /^https?:/.test(at) && ready === "complete" && /html/.test(type);
        const late = Date.now() >= deadline;
        if (loaded && (state === before || late)) {
          const html = await evaluate(HTML);
          if (typeof html !== "string" || !html) {
            throw new Error("The browser opened the page but read nothing.");
          }
          return { got: "page", html, at };
        }
        if (late) {
          throw new Error(
            "The browser opened the address but it gave neither a file nor a page.",
          );
        }
        before = loaded && typeof state === "string" ? state : undefined;
        await sleep(pollMs);
      }
    },
  );
}
