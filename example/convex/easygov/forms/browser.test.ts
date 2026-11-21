// Reading a page through the hosted browser, against a stand-in for the
// service and the browser's connection.
import { expect, test, vi } from "vitest";
import { BrowserBusy, openViaBrowser } from "./browser";

type Sent = {
  id: number;
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
};

/** A browser connection that answers each command as `answer` says. */
function fakeBrowser(answer: (sent: Sent) => unknown) {
  const sent: Sent[] = [];
  class FakeSocket {
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
      const message = JSON.parse(raw) as Sent;
      sent.push(message);
      const result = answer(message);
      setTimeout(
        () =>
          this.emit("message", {
            data: JSON.stringify({ id: message.id, result }),
          }),
        0,
      );
    }
    close() {}
  }
  return { sent, Socket: FakeSocket as unknown as typeof WebSocket };
}

function fakeService(Socket: typeof WebSocket) {
  const fetchMock = vi.fn<typeof fetch>(async (input) =>
    String(input).endsWith("/sessions")
      ? Response.json({ id: "s1", connectUrl: "wss://browser.example/s1" })
      : Response.json({}),
  );
  return {
    fetchMock,
    service: {
      apiKey: "key",
      projectId: "p1",
      fetch: fetchMock,
      WebSocket: Socket,
      pollMs: 1,
    },
  };
}

const STATE = "JSON.stringify([location.href";
const state = (at: string, ready = "complete", type = "text/html") => ({
  result: { value: JSON.stringify([at, ready, type]) },
});

/** A browser that opens a tab, and shows `pages` in turn as it loads. */
const showing = (pages: ReturnType<typeof state>[], html: unknown) => {
  let asked = 0;
  return fakeBrowser(({ method, params }) => {
    if (method === "Target.createTarget") return { targetId: "t1" };
    if (method === "Target.attachToTarget") return { sessionId: "page1" };
    if (method !== "Runtime.evaluate") return {};
    if (String(params.expression).startsWith(STATE))
      return pages[Math.min(asked++, pages.length - 1)];
    return { result: { value: html } };
  });
};

test("reads a page once it has loaded, says where it ended up, and releases the browser", async () => {
  const { sent, Socket } = showing(
    [
      // A new tab is a blank page that already says it has loaded.
      state("about:blank"),
      state("https://www.ssa.gov/forms/", "loading"),
      state("https://www.ssa.gov/forms/index.html"),
    ],
    '<html><a href="/forms/ssa-561.pdf">SSA-561</a></html>',
  );
  const { fetchMock, service } = fakeService(Socket);

  const opened = await openViaBrowser("https://www.ssa.gov/forms/", service);

  expect(opened).toMatchObject({
    got: "page",
    html: expect.stringContaining('href="/forms/ssa-561.pdf"'),
    at: "https://www.ssa.gov/forms/index.html",
  });
  expect(sent.map(({ method }) => method).slice(0, 3)).toEqual([
    "Browser.setDownloadBehavior",
    "Target.createTarget",
    "Target.attachToTarget",
  ]);
  expect(sent[1]).toMatchObject({
    params: { url: "https://www.ssa.gov/forms/" },
  });
  // It asked the page itself, not the browser.
  expect(sent.at(-1)).toMatchObject({
    method: "Runtime.evaluate",
    sessionId: "page1",
  });
  // The session is released whatever happens.
  const release = fetchMock.mock.calls.at(-1)!;
  expect(String(release[0])).toMatch(/\/sessions\/s1$/);
  expect(JSON.parse(String(release[1]?.body))).toMatchObject({
    status: "REQUEST_RELEASE",
  });
});

test("says so when the page gives nothing, and still releases the browser", async () => {
  const { Socket } = showing([state("https://www.ssa.gov/forms/")], undefined);
  const { fetchMock, service } = fakeService(Socket);
  await expect(
    openViaBrowser("https://www.ssa.gov/forms/", service),
  ).rejects.toThrow("read nothing");
  expect(String(fetchMock.mock.calls.at(-1)![0])).toMatch(/\/sessions\/s1$/);
});

/** A service whose download list is empty until `after` lists. */
function downloading(file: Response | (() => Response), after = 1) {
  let lists = 0;
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.endsWith("/sessions"))
      return Response.json({ id: "s1", connectUrl: "wss://browser/s1" });
    if (url.includes("/downloads?"))
      return Response.json({
        downloads: ++lists > after ? [{ id: "d1" }] : [],
      });
    if (url.endsWith("/downloads/d1"))
      return typeof file === "function" ? file() : file;
    return Response.json({});
  });
}

test("collects what the address downloads, with EasyGov's proxy and CAPTCHA settings, and releases the session", async () => {
  const { sent, Socket } = showing([state("about:blank")], undefined);
  const fetchMock = downloading(new Response("%PDF-1.7 a form"));
  const opened = await openViaBrowser("https://a.gov/f.pdf", {
    apiKey: "key",
    projectId: "p1",
    pollMs: 1,
    fetch: fetchMock,
    WebSocket: Socket,
  });
  expect(opened.got === "file" && new TextDecoder().decode(opened.bytes)).toBe(
    "%PDF-1.7 a form",
  );
  expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
    projectId: "p1",
    browserSettings: { blockAds: true, solveCaptchas: true },
    proxies: true,
    timeout: 90,
  });
  expect(sent[0]).toMatchObject({
    method: "Browser.setDownloadBehavior",
    params: {
      behavior: "allow",
      downloadPath: "downloads",
      eventsEnabled: true,
    },
  });
  expect(JSON.parse(String(fetchMock.mock.calls.at(-1)![1]?.body))).toEqual({
    projectId: "p1",
    status: "REQUEST_RELEASE",
  });
});

test("a download larger than any form is refused, not held", async () => {
  const { Socket } = showing([state("about:blank")], undefined);
  const chunk = new Uint8Array(1024 * 1024);
  const huge = () => {
    let sent = 0;
    return new Response(
      new ReadableStream({
        pull(controller) {
          if (sent++ < 30) controller.enqueue(chunk);
          else controller.close();
        },
      }),
    );
  };
  await expect(
    openViaBrowser("https://a.gov/f.pdf", {
      apiKey: "key",
      pollMs: 1,
      fetch: downloading(huge, 0),
      WebSocket: Socket,
    }),
  ).rejects.toThrow("The file is too large.");
});

test("gives up when the address gives neither a file nor a page, and still lets the browser go", async () => {
  const { Socket } = showing([state("about:blank")], undefined);
  const fetchMock = downloading(new Response(""), Infinity);
  await expect(
    openViaBrowser("https://a.gov/page", {
      apiKey: "key",
      pollMs: 1,
      timeoutMs: 50,
      fetch: fetchMock,
      WebSocket: Socket,
    }),
  ).rejects.toThrow(/neither a file nor a page/);
  expect(
    JSON.parse(String(fetchMock.mock.calls.at(-1)![1]?.body)),
  ).toMatchObject({ status: "REQUEST_RELEASE" });
});

test("refuses when the service won't start a browser", async () => {
  const fetchMock = vi.fn<typeof fetch>(
    async () => new Response(null, { status: 402 }),
  );
  await expect(
    openViaBrowser("https://www.ssa.gov/forms/", {
      apiKey: "key",
      fetch: fetchMock,
    }),
  ).rejects.toThrow("The browser service answered 402.");
});

test("gives up, says where, and lets the browser go when it never connects", async () => {
  vi.useFakeTimers();
  class Silent {
    addEventListener() {}
    send() {}
    close() {}
  }
  const { service, fetchMock } = fakeService(
    Silent as unknown as typeof WebSocket,
  );
  const failed = expect(
    openViaBrowser("https://www.ssa.gov/forms/", service),
  ).rejects.toThrow("The browser stalled while connecting to the browser.");
  await vi.advanceTimersByTimeAsync(21_000);
  await failed;
  expect(String(fetchMock.mock.calls.at(-1)![0])).toMatch(/\/sessions\/s1$/);
  vi.useRealTimers();
});

test("asks a busy service again, then says it is busy and learned nothing", async () => {
  const fetchMock = vi.fn<typeof fetch>(
    async () => new Response(null, { status: 429 }),
  );
  await expect(
    openViaBrowser("https://www.ssa.gov/forms/", {
      apiKey: "key",
      fetch: fetchMock,
      busyWaitMs: 1,
    }),
  ).rejects.toBeInstanceOf(BrowserBusy);
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

test("a busy service that frees up is used", async () => {
  const { Socket } = showing(
    [state("https://www.ssa.gov/forms/")],
    "<html></html>",
  );
  let asked = 0;
  const fetchMock = vi.fn<typeof fetch>(async (input) =>
    String(input).endsWith("/sessions")
      ? ++asked === 1
        ? new Response(null, { status: 429 })
        : Response.json({ id: "s1", connectUrl: "wss://browser.example/s1" })
      : Response.json({}),
  );
  const opened = await openViaBrowser("https://www.ssa.gov/forms/", {
    apiKey: "key",
    fetch: fetchMock,
    WebSocket: Socket,
    pollMs: 1,
    busyWaitMs: 1,
  });
  expect(opened).toMatchObject({ got: "page", html: "<html></html>" });
});

test("gives up when the service stops answering", async () => {
  vi.useFakeTimers();
  const { Socket } = showing([state("about:blank")], undefined);
  const fetchMock = vi.fn<typeof fetch>(async (input) =>
    String(input).endsWith("/sessions")
      ? Response.json({ id: "s1", connectUrl: "wss://browser.example/s1" })
      : String(input).includes("/downloads?")
        ? await new Promise<Response>(() => undefined)
        : Response.json({}),
  );
  const failed = expect(
    openViaBrowser("https://www.ssa.gov/forms/ssa-561.pdf", {
      apiKey: "key",
      fetch: fetchMock,
      WebSocket: Socket,
    }),
  ).rejects.toThrow("The browser stalled while looking for the download.");
  await vi.advanceTimersByTimeAsync(16_000);
  await failed;
  vi.useRealTimers();
});

test("a connection that closes without opening is a failure, not a wait", async () => {
  class Closing {
    addEventListener(type: string, listener: () => void) {
      if (type === "close") setTimeout(listener, 0);
    }
    send() {}
    close() {}
  }
  const { service } = fakeService(Closing as unknown as typeof WebSocket);
  await expect(
    openViaBrowser("https://www.ssa.gov/forms/", service),
  ).rejects.toThrow("Couldn't connect to the browser.");
});
