// Reading a page through the hosted browser, against a stand-in for the
// service and the browser's connection.
import { expect, test, vi } from "vitest";
import { readViaBrowser } from "./browser";

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

test("reads a page's HTML once it has loaded, and releases the browser", async () => {
  let asked = 0;
  const { sent, Socket } = fakeBrowser(({ method, params }) => {
    if (method === "Target.createTarget") return { targetId: "t1" };
    if (method === "Target.attachToTarget") return { sessionId: "page1" };
    if (String(params.expression).startsWith("location.href")) {
      // A new tab is a blank page that already says it has loaded.
      const states = [
        "about:blank complete",
        "https://www.ssa.gov/forms/ loading",
        "https://www.ssa.gov/forms/ complete",
      ];
      return { result: { value: states[Math.min(asked++, 2)] } };
    }
    return {
      result: {
        value: '<html><a href="/forms/ssa-561.pdf">SSA-561</a></html>',
      },
    };
  });
  const { fetchMock, service } = fakeService(Socket);

  const html = await readViaBrowser("https://www.ssa.gov/forms/", service);

  expect(html).toContain('href="/forms/ssa-561.pdf"');
  expect(sent[0]).toMatchObject({
    method: "Target.createTarget",
    params: { url: "https://www.ssa.gov/forms/" },
  });
  // It waited for the page, and asked the page itself, not the browser.
  expect(asked).toBe(3);
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
  const { Socket } = fakeBrowser(({ method, params }) => {
    if (method === "Target.createTarget") return { targetId: "t1" };
    if (method === "Target.attachToTarget") return { sessionId: "page1" };
    if (String(params.expression).startsWith("location.href")) {
      return { result: { value: "https://www.ssa.gov/forms/ complete" } };
    }
    return { result: {} };
  });
  const { fetchMock, service } = fakeService(Socket);
  await expect(
    readViaBrowser("https://www.ssa.gov/forms/", service),
  ).rejects.toThrow("read nothing");
  expect(String(fetchMock.mock.calls.at(-1)![0])).toMatch(/\/sessions\/s1$/);
});

test("refuses when the service won't start a browser", async () => {
  const fetchMock = vi.fn<typeof fetch>(
    async () => new Response(null, { status: 402 }),
  );
  await expect(
    readViaBrowser("https://www.ssa.gov/forms/", {
      apiKey: "key",
      fetch: fetchMock,
    }),
  ).rejects.toThrow("The browser service answered 402.");
});

test("gives up, and says where, when the browser never connects", async () => {
  vi.useFakeTimers();
  class Silent {
    addEventListener() {}
    send() {}
    close() {}
  }
  const { service } = fakeService(Silent as unknown as typeof WebSocket);
  const reading = readViaBrowser("https://www.ssa.gov/forms/", service);
  const failed = expect(reading).rejects.toThrow(
    "The browser stalled while connecting to the browser.",
  );
  await vi.advanceTimersByTimeAsync(21_000);
  await failed;
  vi.useRealTimers();
});
