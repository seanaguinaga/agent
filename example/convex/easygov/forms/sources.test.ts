import { describe, expect, test } from "vitest";
import { downloadViaBrowser } from "./browser";
import { namesForm, notAPdf, obtain } from "./sources";

const pdf = new TextEncoder().encode("%PDF-1.7 a form");
const page = new TextEncoder().encode("<html>Access denied</html>");
const fails = (message: string) => async () => {
  throw new Error(message);
};

describe("getting a form's bytes", () => {
  test("a plain request that works is all that's tried", async () => {
    let browsers = 0;
    const got = await obtain(["https://a.gov/f.pdf"], {
      request: async () => pdf,
      browser: async () => (browsers++, pdf),
    });
    expect(got).toMatchObject({ via: "request", url: "https://a.gov/f.pdf" });
    expect(browsers).toBe(0);
  });

  test("when the request is refused, a real browser opens the same address", async () => {
    const got = await obtain(["https://a.gov/f.pdf"], {
      request: fails("The source answered 403."),
      browser: async () => pdf,
    });
    expect(got).toMatchObject({
      via: "browser",
      attempts: [
        { via: "request", ok: false, note: "The source answered 403." },
        { via: "browser", ok: true, note: "15 bytes" },
      ],
    });
  });

  test("every address is tried the cheap way before any is tried the dear way", async () => {
    const tried: string[] = [];
    const got = await obtain(["https://a.gov/f.pdf", "https://b.gov/f.pdf"], {
      request: async (url) => {
        tried.push(`request ${url}`);
        if (url.includes("b.gov")) return pdf;
        throw new Error("403");
      },
      browser: async (url) => (tried.push(`browser ${url}`), pdf),
    });
    expect(tried).toEqual([
      "request https://a.gov/f.pdf",
      "request https://b.gov/f.pdf",
    ]);
    expect(got).toMatchObject({ via: "request", url: "https://b.gov/f.pdf" });
  });

  test("a page that isn't the form doesn't count, and a form nobody can reach says why", async () => {
    const got = await obtain(["https://a.gov/f.pdf"], {
      request: async () => page,
      browser: fails("The browser opened the address but downloaded nothing."),
    });
    expect("bytes" in got).toBe(false);
    expect(got.attempts).toEqual([
      {
        via: "request",
        url: "https://a.gov/f.pdf",
        ok: false,
        note: "It isn't a PDF.",
      },
      {
        via: "browser",
        url: "https://a.gov/f.pdf",
        ok: false,
        note: "The browser opened the address but downloaded nothing.",
      },
    ]);
    // With no browser service set up, only the request is tried.
    const plain = await obtain(["https://a.gov/f.pdf"], {
      request: fails("403"),
    });
    expect(plain.attempts).toHaveLength(1);
  });

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
