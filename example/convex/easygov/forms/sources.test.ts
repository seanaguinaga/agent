import { describe, expect, test } from "vitest";
import { downloadViaBrowser } from "./browser";
import { namesForm, notAPdf } from "./sources";

const pdf = new TextEncoder().encode("%PDF-1.7 a form");
const page = new TextEncoder().encode("<html>Access denied</html>");
describe("getting a form's bytes", () => {
  test("the bytes have to be a PDF, and name the form they're meant to be", () => {
    expect(notAPdf(pdf)).toBeNull();
    expect(notAPdf(page)).toBe("It isn't a PDF.");
    expect(
      namesForm("IRS-8822", "Form 8822 (Rev. February 2021) Change of Address"),
    ).toBe(true);
    expect(
      namesForm("SSA SS-5", "Form SS-5 Application for a Social Security Card"),
    ).toBe(true);
    expect(
      namesForm("W-9", "Form W-9 Request for Taxpayer Identification"),
    ).toBe(true);
    expect(
      namesForm("IRS-8822", "Form 8821 Tax Information Authorization"),
    ).toBe(false);
  });
});

describe("a hosted browser", () => {
  /** A stand-in for the browser service: records what it's asked. */
  function service(downloadsAfter: number) {
    const calls: { method: string; url: string; body?: unknown }[] = [];
    const sent: { method: string; params: unknown }[] = [];
    let lists = 0;
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({
        method,
        url,
        body: init?.body && JSON.parse(String(init.body)),
      });
      const json = (value: unknown) => new Response(JSON.stringify(value));
      if (method === "POST" && url.endsWith("/sessions")) {
        return json({ id: "s1", connectUrl: "wss://browser/s1" });
      }
      if (url.includes("/downloads?")) {
        return json({
          downloads: ++lists > downloadsAfter ? [{ id: "d1" }] : [],
        });
      }
      if (url.endsWith("/downloads/d1")) return new Response(pdf);
      return json({});
    }) as typeof globalThis.fetch;
    class Socket {
      constructor(public url: string) {}
      addEventListener(type: string, listener: () => void) {
        if (type === "open") queueMicrotask(listener);
      }
      send(message: string) {
        const { method, params } = JSON.parse(message);
        sent.push({ method, params });
      }
      close() {
        sent.push({ method: "close", params: null });
      }
    }
    return {
      calls,
      sent,
      options: {
        apiKey: "key",
        projectId: "p1",
        pollMs: 1,
        timeoutMs: 50,
        fetch,
        WebSocket: Socket as unknown as typeof WebSocket,
      },
    };
  }

  test("uses EasyGov's proxy and CAPTCHA settings, collects the download, and releases the session", async () => {
    const { calls, sent, options } = service(1);
    const bytes = await downloadViaBrowser("https://a.gov/f.pdf", options);
    expect(new TextDecoder().decode(bytes)).toBe("%PDF-1.7 a form");
    expect(calls[0]).toEqual({
      method: "POST",
      url: "https://api.browserbase.com/v1/sessions",
      body: {
        projectId: "p1",
        browserSettings: { blockAds: true, solveCaptchas: true },
        proxies: true,
        timeout: 90,
      },
    });
    expect(sent).toEqual([
      {
        method: "Browser.setDownloadBehavior",
        params: {
          behavior: "allow",
          downloadPath: "downloads",
          eventsEnabled: true,
        },
      },
      { method: "Target.createTarget", params: { url: "https://a.gov/f.pdf" } },
      { method: "close", params: null },
    ]);
    expect(calls.at(-1)).toEqual({
      method: "POST",
      url: "https://api.browserbase.com/v1/sessions/s1",
      body: { projectId: "p1", status: "REQUEST_RELEASE" },
    });
  });

  test("gives up when nothing downloads, and still lets the browser go", async () => {
    const { calls, options } = service(Infinity);
    await expect(
      downloadViaBrowser("https://a.gov/page", options),
    ).rejects.toThrow(/downloaded nothing/);
    expect(calls.at(-1)?.body).toMatchObject({ status: "REQUEST_RELEASE" });
  });
});
