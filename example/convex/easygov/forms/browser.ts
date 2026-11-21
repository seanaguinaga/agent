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

/**
 * Opens `url` in a hosted browser and returns the file it downloads. A PDF
 * address downloads instead of displaying. Throws if no file arrives, and
 * never waits long: every step has a limit, and a stall says which step.
 */
export async function downloadViaBrowser(
  url: string,
  service: BrowserService,
): Promise<Uint8Array> {
  const { timeoutMs = 45_000, pollMs = 2_000 } = service;
  return await inBrowser(
    service,
    async ({ id, socket, headers, request, step }) => {
      // Keep what it downloads where the service can hand it back.
      socket.send(
        JSON.stringify({
          id: 1,
          method: "Browser.setDownloadBehavior",
          params: {
            behavior: "allow",
            downloadPath: "downloads",
            eventsEnabled: true,
          },
        }),
      );
      socket.send(
        JSON.stringify({
          id: 2,
          method: "Target.createTarget",
          params: { url },
        }),
      );

      const deadline = Date.now() + timeoutMs;
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
          return new Uint8Array(
            await step("collecting the download", file.arrayBuffer(), 30_000),
          );
        }
        if (Date.now() >= deadline) {
          throw new Error(
            "The browser opened the address but downloaded nothing.",
          );
        }
        await sleep(pollMs);
      }
    },
  );
}

/** What the browser answers a command with, or why it refused. */
type Reply = { id?: number; result?: unknown; error?: { message?: string } };

/**
 * Opens `url` in a hosted browser and returns the page's HTML once it has
 * loaded. For an authority's page that refuses a plain request: the page is
 * only read for the links it carries. Throws if nothing can be read, and
 * never waits long: every step has a limit, and a stall says which step.
 */
export async function readViaBrowser(
  url: string,
  service: BrowserService,
): Promise<string> {
  // A page is only somewhere a link may be: it isn't waited on for long.
  const { timeoutMs = 25_000, pollMs = 1_000 } = service;
  return await inBrowser(service, async ({ socket: open }) => {
    // Each command is answered under its own number.
    let next = 1;
    const waiting = new Map<
      number,
      { resolve: (result: unknown) => void; reject: (error: Error) => void }
    >();
    open.addEventListener("message", (event) => {
      let reply: Reply;
      try {
        reply = JSON.parse(String(event.data)) as Reply;
      } catch {
        return;
      }
      const pending =
        reply.id === undefined ? undefined : waiting.get(reply.id);
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
    const deadline = Date.now() + timeoutMs;
    const call = <T>(
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
        open.send(
          JSON.stringify({
            id,
            method,
            params,
            ...(sessionId && { sessionId }),
          }),
        );
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

    // A new tab starts as a blank page that already counts as loaded, so
    // wait until it is somewhere and that page has finished. Past the
    // deadline, take what there is.
    while (Date.now() < deadline) {
      const state = await evaluate(
        "location.href + ' ' + document.readyState",
      ).catch(() => "");
      if (
        typeof state === "string" &&
        /^https?:/.test(state) &&
        state.endsWith(" complete")
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    const html = await evaluate("document.documentElement.outerHTML");
    if (typeof html !== "string" || !html) {
      throw new Error("The browser opened the page but read nothing.");
    }
    return html;
  });
}
