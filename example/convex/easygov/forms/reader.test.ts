// @vitest-environment node
// Reading a scan's words: each reader and everything it can answer, against
// a stand-in model and a stand-in network. No request leaves the machine.
import { createVerify, generateKeyPairSync } from "node:crypto";
import { APICallError } from "ai";
import { PDFDocument } from "pdf-lib";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ActionCtx } from "../../_generated/server";
import { initConvexTest } from "../../setup.test";
import { scans } from "../case/cases.testkit";
import {
  fakeNetwork,
  fakeReader,
  restoreNetwork,
  scanPdf,
  type Served,
} from "./network.testkit";
import { firstPages, reader, transcribe, type Reader } from "./reader";
import { costRead, settled, wordsFrom } from "./words";

vi.mock("../../modelsForDemo", async () =>
  (await import("../case/cases.testkit")).mockModels(),
);
afterEach(() => {
  restoreNetwork();
  vi.unstubAllEnvs();
  scans.kind = "model";
});

const ctx = () => {
  const t = initConvexTest();
  return { runQuery: t.query, runMutation: t.mutation } as unknown as ActionCtx;
};
const pagesOf = async (pdf: Uint8Array) =>
  (await PDFDocument.load(pdf)).getPageCount();
const refusal = (statusCode: number) =>
  new APICallError({
    message: `HTTP ${statusCode}`,
    url: "https://gateway.test",
    requestBodyValues: {},
    statusCode,
  });

test("a reader is sent a file's first three pages, and a short file whole", async () => {
  const long = await scanPdf(5);
  expect(await pagesOf(await firstPages(long, 3))).toBe(3);
  const short = await scanPdf(3);
  expect(await firstPages(short, 3)).toBe(short);
});

describe("a model as the reader", () => {
  const read = async (...answer: Parameters<typeof fakeReader>) => {
    const { model, sent } = await fakeReader(...answer);
    const transcript = await transcribe(
      ctx(),
      { kind: "model", model },
      await scanPdf(5),
    );
    return { transcript, sent };
  };

  test("gives each page's words, from the cut file and nothing else", async () => {
    const { transcript, sent } = await read(
      "=====\n=====\nV62 Application for a vehicle registration certificate\n=====\nNotes",
    );
    expect(transcript).toEqual({
      got: "text",
      pages: [
        "",
        "\n",
        "\nV62 Application for a vehicle registration certificate\n",
        "\nNotes",
      ],
    });
    // A picture cover is passed over: the first page with words tells it.
    expect(wordsFrom(transcript, "a-model")).toEqual({
      from: "ocr",
      opening: "\nV62 Application for a vehicle registration certificate\n",
      by: "a-model",
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].words).toHaveLength(1);
    expect(sent[0].files).toHaveLength(1);
    expect(await pagesOf(sent[0].files[0])).toBe(3);
  });

  test("with no words on any page, the file is blank: settled, and a read was spent", async () => {
    const { transcript } = await read("=====\n=====\n  \n");
    const words = wordsFrom(transcript, "a-model");
    expect(words).toEqual({ from: "none", why: "blank" });
    expect(settled(words)).toBe(true);
    expect(costRead(words)).toBe(true);
  });

  test.each([
    [429, { got: "refused", why: "quota" }],
    [401, { got: "refused", why: "denied" }],
    [403, { got: "refused", why: "denied" }],
    [413, { got: "tooLarge" }],
    [503, { got: "unavailable" }],
    [400, { got: "failed" }],
  ])("turned away with %i says why", async (status, outcome) => {
    const { transcript } = await read(refusal(status));
    expect(transcript).toMatchObject(outcome);
  });

  test("an error that isn't an answer is unavailable, and a model that stops short has failed: neither is settled", async () => {
    const down = (await read(new Error("socket hang up"))).transcript;
    expect(down).toEqual({ got: "unavailable", note: "socket hang up" });
    const stopped = (await read("", "content-filter")).transcript;
    expect(stopped).toMatchObject({ got: "failed" });
    for (const transcript of [down, stopped]) {
      expect(settled(wordsFrom(transcript, "a-model"))).toBe(false);
    }
  });
});

describe("Document AI as the reader", () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const email = "reader@project.iam.gserviceaccount.com";
  const processor = "projects/p/locations/us/processors/abc";
  const documentAi: Reader = {
    kind: "documentAi",
    processor,
    account: { email, key: privateKey },
  };
  const tokens = "https://oauth2.googleapis.com/token";
  const process = `https://us-documentai.googleapis.com/v1/${processor}:process`;
  const grant: Served = () => Response.json({ access_token: "token-1" });
  const read = async (served: Served, token = grant) => {
    const net = fakeNetwork({ [tokens]: token, [process]: served });
    const transcript = await transcribe(ctx(), documentAi, await scanPdf(5));
    return { transcript, requests: net.requests };
  };

  test("asks for a token with a request the account's key signed, then sends the cut file and nothing else", async () => {
    const text = "V62 ApplicationNotes";
    const { transcript, requests } = await read(() =>
      Response.json({
        document: {
          text,
          pages: [
            {},
            // The first stretch of a document starts at 0, which isn't sent.
            { layout: { textAnchor: { textSegments: [{ endIndex: "15" }] } } },
            {
              layout: {
                textAnchor: {
                  textSegments: [{ startIndex: "15", endIndex: "20" }],
                },
              },
            },
          ],
        },
      }),
    );
    expect(transcript).toEqual({
      got: "text",
      pages: ["", "V62 Application", "Notes"],
    });

    const [token, sent] = requests;
    expect(requests.map(({ url, method }) => [url, method])).toEqual([
      [tokens, "POST"],
      [process, "POST"],
    ]);
    const form = token.body as URLSearchParams;
    expect(form.get("grant_type")).toBe(
      "urn:ietf:params:oauth:grant-type:jwt-bearer",
    );
    const [header, claims, signature] = form.get("assertion")!.split(".");
    const decoded = (part: string) =>
      JSON.parse(Buffer.from(part, "base64url").toString());
    expect(decoded(header)).toEqual({ alg: "RS256", typ: "JWT" });
    const { iat, exp, ...rest } = decoded(claims);
    expect(rest).toEqual({
      iss: email,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      aud: tokens,
    });
    expect(exp - iat).toBe(3600);
    expect(Math.abs(iat - Date.now() / 1000)).toBeLessThan(60);
    expect(
      createVerify("RSA-SHA256")
        .update(`${header}.${claims}`)
        .verify(publicKey, signature, "base64url"),
    ).toBe(true);

    expect(sent.headers.get("authorization")).toBe("Bearer token-1");
    const body = JSON.parse(sent.body as string);
    expect(Object.keys(body)).toEqual(["rawDocument"]);
    expect(body.rawDocument.mimeType).toBe("application/pdf");
    const pdf = Buffer.from(body.rawDocument.content, "base64");
    expect(await pagesOf(new Uint8Array(pdf))).toBe(3);
  });

  test.each([
    [429, { got: "refused", why: "quota" }],
    [401, { got: "refused", why: "denied" }],
    [403, { got: "refused", why: "denied" }],
    [413, { got: "tooLarge" }],
    [503, { got: "unavailable" }],
    [400, { got: "failed" }],
  ])("turned away with %i says why", async (status, outcome) => {
    const { transcript } = await read(() => new Response(null, { status }));
    expect(transcript).toMatchObject(outcome);
  });

  test("with no token, the file is never sent; with no answer, it is unavailable", async () => {
    const denied = await read(
      () => Response.json({ document: {} }),
      () => new Response(null, { status: 401 }),
    );
    expect(denied.transcript).toMatchObject({ got: "refused", why: "denied" });
    expect(denied.requests).toHaveLength(1);
    const down = await read(() => {
      throw new Error("socket hang up");
    });
    expect(down.transcript).toEqual({
      got: "unavailable",
      note: "socket hang up",
    });
  });

  test("runs only where it is chosen and its account and processor are set", () => {
    scans.kind = "documentAi";
    expect(reader()).toBeUndefined();
    vi.stubEnv("DOCUMENT_AI_PROCESSOR", processor);
    vi.stubEnv(
      "DOCUMENT_AI_CREDENTIALS",
      JSON.stringify({ client_email: email, private_key: privateKey }),
    );
    expect(reader()).toEqual(documentAi);
    // A key that can't be read is said so, without a word of it.
    vi.stubEnv("DOCUMENT_AI_CREDENTIALS", `{"private_key": "${privateKey}`);
    expect(reader).toThrow(/^DOCUMENT_AI_CREDENTIALS isn't an account's key/);
    // The model reads only where it is the one chosen, and there is one.
    scans.kind = "model";
    expect(reader()).toBeUndefined();
  });
});
