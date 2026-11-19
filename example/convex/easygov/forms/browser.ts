"use node";
// Opening an address in a real, hosted browser and collecting the file it
// downloads. For the authority's sites that a plain request can't read: a
// link that needs a browser to follow, a download that starts from a page.
//
// This talks to Browserbase directly: create a session, tell it to open the
// address, and collect the download. That's all a browser is needed for
// here, so there's no automation library and no model.
//
// It is a real browser and nothing more. Captcha solving, proxies and
// fingerprint masking are left off on purpose: if a site turns the browser
// away, the form is reported as unreachable. We don't try to get past it.

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
  const { apiKey, projectId, timeoutMs = 45_000, pollMs = 2_000 } = service;
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
      // A plain browser: see the note at the top of this file.
      browserSettings: { solveCaptchas: false },
      timeout: 120,
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
