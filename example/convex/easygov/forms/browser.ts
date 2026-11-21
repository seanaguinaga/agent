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
  /** For tests. */
  fetch?: typeof fetch;
  WebSocket?: typeof WebSocket;
};

type Download = { id: string; mimeType: string; size: number };

/** The browser service from the environment, if its keys are set. */
export function browserService(): BrowserService | undefined {
  const apiKey = process.env.BROWSERBASE_API_KEY;
  if (!apiKey) return undefined;
  return { apiKey, projectId: process.env.BROWSERBASE_PROJECT_ID };
}

/** Sends the browser a command once the connection is open. */
function command(
  socket: WebSocket,
  id: number,
  method: string,
  params: Record<string, unknown>,
) {
  socket.send(JSON.stringify({ id, method, params }));
}

/**
 * Opens `url` in a hosted browser and returns the file it downloads. A PDF
 * address downloads instead of displaying. Throws if no file arrives.
 */
export async function downloadViaBrowser(
  url: string,
  service: BrowserService,
): Promise<Uint8Array> {
  const { apiKey, projectId, timeoutMs = 60_000, pollMs = 2_000 } = service;
  const request = service.fetch ?? fetch;
  const Socket = service.WebSocket ?? WebSocket;
  const headers = {
    "X-BB-API-Key": apiKey,
    "Content-Type": "application/json",
  };

  const created = await request(`${API}/sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      ...(projectId && { projectId }),
      browserSettings: { blockAds: true, solveCaptchas: true },
      proxies: true,
      timeout: 90,
    }),
  });
  if (!created.ok) {
    throw new Error(`The browser service answered ${created.status}.`);
  }
  const session = (await created.json()) as { id: string; connectUrl: string };

  let socket: WebSocket | undefined;
  try {
    socket = new Socket(session.connectUrl);
    const open = socket;
    await new Promise<void>((resolve, reject) => {
      open.addEventListener("open", () => resolve(), { once: true });
      open.addEventListener(
        "error",
        () => reject(new Error("Couldn't connect to the browser.")),
        { once: true },
      );
    });
    // Keep what it downloads where the service can hand it back.
    command(open, 1, "Browser.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: "downloads",
      eventsEnabled: true,
    });
    command(open, 2, "Target.createTarget", { url });

    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const listed = await request(
        `${API}/downloads?${new URLSearchParams({ sessionId: session.id, limit: "1" })}`,
        { headers },
      );
      if (!listed.ok) {
        throw new Error(`Listing downloads answered ${listed.status}.`);
      }
      const { downloads = [] } = (await listed.json()) as {
        downloads?: Download[];
      };
      const [download] = downloads;
      if (download) {
        const file = await request(
          `${API}/downloads/${encodeURIComponent(download.id)}`,
          { headers: { ...headers, Accept: "application/octet-stream" } },
        );
        if (!file.ok) {
          throw new Error(`Fetching the download answered ${file.status}.`);
        }
        return new Uint8Array(await file.arrayBuffer());
      }
      if (Date.now() >= deadline) {
        throw new Error(
          "The browser opened the address but downloaded nothing.",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  } finally {
    socket?.close();
    // Don't leave a browser running on the account.
    await request(`${API}/sessions/${encodeURIComponent(session.id)}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        ...(projectId && { projectId }),
        status: "REQUEST_RELEASE",
      }),
    }).catch(() => undefined);
  }
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
  const { apiKey, projectId, timeoutMs = 45_000, pollMs = 1_000 } = service;
  // What it is doing now, so a stall can say where it stalled.
  let stage = "starting a browser";
  const within = <T>(wait: Promise<T>, ms: number): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`The browser stalled while ${stage}.`)),
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
  const request = service.fetch ?? fetch;
  const Socket = service.WebSocket ?? WebSocket;
  const headers = {
    "X-BB-API-Key": apiKey,
    "Content-Type": "application/json",
  };
  const created = await within(
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
  if (!created.ok) {
    throw new Error(`The browser service answered ${created.status}.`);
  }
  const session = (await created.json()) as { id: string; connectUrl: string };

  let socket: WebSocket | undefined;
  try {
    socket = new Socket(session.connectUrl);
    const open = socket;
    stage = "connecting to the browser";
    await within(
      new Promise<void>((resolve, reject) => {
        open.addEventListener("open", () => resolve(), { once: true });
        open.addEventListener(
          "error",
          () => reject(new Error("Couldn't connect to the browser.")),
          { once: true },
        );
      }),
      20_000,
    );

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

    stage = "opening the page";
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

    stage = "waiting for the page to load";
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
    stage = "reading the page";
    const html = await evaluate("document.documentElement.outerHTML");
    if (typeof html !== "string" || !html) {
      throw new Error("The browser opened the page but read nothing.");
    }
    return html;
  } finally {
    socket?.close();
    // Don't leave a browser running on the account.
    stage = "releasing the browser";
    await within(
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
