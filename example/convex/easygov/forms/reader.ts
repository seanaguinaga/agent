"use node";
// Reading the words off a file that has none of its own: a scan. A caller
// asks `fileWords` and never sees a reader. Beneath it, `transcribe` gives
// one reader the file's first pages and gets back their words, and only
// words: it is never told which form is wanted. See WORDS.md.
import { createSign } from "node:crypto";
import { APICallError, generateText, type LanguageModel } from "ai";
import { PDFDocument } from "pdf-lib";
import { z } from "zod/v4";
import type { ActionCtx } from "../../_generated/server";
import { readerModel, readerOrder, readerRetries } from "../../modelsForDemo";
import { chargeUsage } from "../limits";
import type { ReadStatus } from "./schema";
import {
  after,
  readAs,
  retryIn,
  settled,
  wordsFrom,
  wordsIn,
  type Words,
} from "./words";

export type Reader =
  | { kind: "model"; model: LanguageModel }
  | {
      kind: "documentAi";
      /** "projects/…/locations/us/processors/…". */
      processor: string;
      account: { email: string; key: string };
    };

/** What a reader made of a file. Its words are all it can say. */
export type Transcript =
  | { got: "text"; pages: string[] }
  | { got: "refused"; why: "quota" | "denied"; note: string }
  | { got: "tooLarge" }
  | { got: "unavailable"; note: string }
  | { got: "failed"; note: string };

const zAccount = z.object({
  client_email: z.string(),
  private_key: z.string(),
});

/** One kind of reader, or undefined where it isn't set up. */
function readerOf(kind: Reader["kind"]): Reader | undefined {
  switch (kind) {
    case "model":
      return readerModel && { kind: "model", model: readerModel };
    case "documentAi": {
      const {
        DOCUMENT_AI_CREDENTIALS: json,
        DOCUMENT_AI_PROCESSOR: processor,
      } = process.env;
      if (!json || !processor) return undefined;
      try {
        const { client_email: email, private_key: key } = zAccount.parse(
          JSON.parse(json),
        );
        return { kind: "documentAi", processor, account: { email, key } };
      } catch {
        // What is wrong with a key is never said in the key's own words. The
        // readers after it still read.
        console.error("DOCUMENT_AI_CREDENTIALS isn't an account's key file.");
        return undefined;
      }
    }
  }
}

/** The readers set up, in the order they are asked: `readerOrder`. */
export const readers = (): Reader[] =>
  readerOrder.flatMap((kind) => readerOf(kind) ?? []);

/** A reader's name, kept with the words it read. */
function nameOf(reader: Reader): string {
  switch (reader.kind) {
    case "model":
      return typeof reader.model === "string"
        ? reader.model
        : reader.model.modelId;
    case "documentAi":
      return "documentAi";
  }
}

/** Whether held words are worth reading again: a reader may now give some. */
export const worthReading = (words: Words, mayRead: boolean): boolean =>
  mayRead && !settled(words) && readers().length > 0;

/**
 * The one place a file's words are asked for: its own, or where it has none
 * and a read may be spent, a reader's. Each reader is asked in turn until
 * one gives words (`after`), and asked again where a short wait may mend
 * what went wrong (`retryIn`): all of it is one read. `tell` hears each
 * step as it happens; what is kept is how it ended.
 */
export async function fileWords(
  ctx: ActionCtx,
  file: { words: string[]; xfa: boolean; pdf: Uint8Array },
  mayRead: boolean,
  tell: (status: ReadStatus) => Promise<unknown> = async () => undefined,
): Promise<Words> {
  const own = wordsIn(file.words, file.xfa);
  if (own !== "unread") return own;
  const [first, ...backups] = readers();
  if (!first) {
    return { from: "none", why: "noReader", note: "No reader is set up." };
  }
  if (!mayRead) return { from: "none", why: "unspent", note: "" };
  let tries = 0;
  const read = async (reader: Reader): Promise<Transcript> => {
    // One reader's tries and waits all end by the one time.
    const until = Date.now() + TIMEOUT;
    const signal = AbortSignal.timeout(TIMEOUT);
    for (let retried = 0; ; retried++) {
      tries++;
      const transcript = await transcribe(ctx, reader, file.pdf, signal);
      const left = until - Date.now();
      const wait = retryIn(transcript, retried, left, readerRetries);
      if (wait === undefined) return transcript;
      await tell("retrying");
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  };
  await tell("reading");
  let by = first;
  let transcript = await read(by);
  for (const backup of backups) {
    if (after(transcript) === "stop") break;
    // The alert that a reader is failing: search the logs for this line.
    console.warn("easygov reader fell back", nameOf(by), transcript);
    await tell("backup");
    by = backup;
    transcript = await read(by);
  }
  const how = { by: nameOf(by), tries, backup: by !== first };
  const words = wordsFrom(transcript, how);
  await tell(readAs(words));
  return words;
}

/** As many pages as are read: a form names itself on its first with words. */
const PAGES = 3;
/** As much as is sent to a reader, which takes it whole in one request. */
const MAX_READ = 15 * 1024 * 1024;
/**
 * As long as one reader has for a file, its tries and the waits between
 * them together: longer than the slowest read measured, 18 s.
 */
const TIMEOUT = 30_000;

/** The first `count` pages of a PDF, as a PDF: all of it if it has no more. */
export async function firstPages(
  pdf: Uint8Array,
  count: number,
): Promise<Uint8Array> {
  const whole = await PDFDocument.load(pdf, {
    ignoreEncryption: true,
    parseSpeed: Infinity,
  });
  if (whole.getPageCount() <= count) return pdf;
  const cut = await PDFDocument.create();
  const pages = await cut.copyPages(whole, [...Array(count).keys()]);
  for (const page of pages) cut.addPage(page);
  return await cut.save({ objectsPerTick: Infinity });
}

/** What a provider's refusal means, by its HTTP status. */
function turnedAway(status: number, note: string): Transcript {
  if (status === 429) return { got: "refused", why: "quota", note };
  if (status === 401 || status === 403) {
    return { got: "refused", why: "denied", note };
  }
  if (status === 413) return { got: "tooLarge" };
  return status >= 500 ? { got: "unavailable", note } : { got: "failed", note };
}

/**
 * The words on a PDF's first pages, as `reader` reads them. Every reader is
 * given the same small file and nothing else. It never throws: what went
 * wrong is an answer.
 */
export async function transcribe(
  ctx: Pick<ActionCtx, "runQuery" | "runMutation">,
  reader: Reader,
  pdf: Uint8Array,
  signal: AbortSignal = AbortSignal.timeout(TIMEOUT),
): Promise<Transcript> {
  try {
    const start = await firstPages(pdf, PAGES);
    if (start.length > MAX_READ) return { got: "tooLarge" };
    switch (reader.kind) {
      case "model":
        return await viaModel(ctx, reader.model, start, signal);
      case "documentAi":
        return await viaDocumentAi(reader, start, signal);
    }
  } catch (error) {
    const note = `${error instanceof Error ? error.message : error}`.slice(
      0,
      200,
    );
    return APICallError.isInstance(error) && error.statusCode
      ? turnedAway(error.statusCode, note)
      : { got: "unavailable", note };
  }
}

/** Each page begins with a line that says only this. */
const PAGE_BREAK = "=====";

async function viaModel(
  ctx: Pick<ActionCtx, "runQuery" | "runMutation">,
  model: LanguageModel,
  pdf: Uint8Array,
  signal: AbortSignal,
): Promise<Transcript> {
  const { text, usage, finishReason } = await generateText({
    model,
    maxRetries: 0,
    abortSignal: signal,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "Transcribe every word printed on each page of this file, exactly as " +
              "printed, in reading order. Begin each page with a line that says " +
              `only ${PAGE_BREAK}. Add nothing of your own: no summary, no ` +
              "description, no formatting. For a page with no words, write nothing.",
          },
          { type: "file", data: pdf, mediaType: "application/pdf" },
        ],
      },
    ],
  });
  await chargeUsage(ctx, undefined, usage.totalTokens);
  if (finishReason !== "stop" && finishReason !== "length") {
    return { got: "failed", note: `The model stopped: ${finishReason}.` };
  }
  return { got: "text", pages: text.split(PAGE_BREAK) };
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const base64url = (part: object) =>
  Buffer.from(JSON.stringify(part)).toString("base64url");

/** A service account's signed request for an access token, good for an hour. */
function assertion({ email, key }: { email: string; key: string }): string {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = [
    base64url({ alg: "RS256", typ: "JWT" }),
    base64url({
      iss: email,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    }),
  ].join(".");
  const signature = createSign("RSA-SHA256").update(unsigned).sign(key);
  return `${unsigned}.${signature.toString("base64url")}`;
}

const zToken = z.object({ access_token: z.string() });
const zDocument = z.object({
  document: z.object({
    text: z.string().default(""),
    pages: z
      .array(
        z.object({
          layout: z
            .object({
              textAnchor: z.object({
                textSegments: z
                  .array(
                    z.object({
                      startIndex: z.coerce.number().default(0),
                      endIndex: z.coerce.number(),
                    }),
                  )
                  .default([]),
              }),
            })
            .optional(),
        }),
      )
      .default([]),
  }),
});

/**
 * Each account's access token, held until well before its hour is up: a
 * second try, or the next file the same action reads, asks for none.
 */
export const tokens = new Map<string, { token: string; until: number }>();

/** Google's Document AI, in `us`: a token for the account, then the file. */
async function viaDocumentAi(
  { processor, account }: Extract<Reader, { kind: "documentAi" }>,
  pdf: Uint8Array,
  signal: AbortSignal,
): Promise<Transcript> {
  const held = tokens.get(account.email);
  let token = held && held.until > Date.now() ? held.token : undefined;
  if (!token) {
    const granted = await fetch(TOKEN_URL, {
      method: "POST",
      signal,
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: assertion(account),
      }),
    });
    if (!granted.ok) {
      return turnedAway(granted.status, `No token: HTTP ${granted.status}.`);
    }
    ({ access_token: token } = zToken.parse(await granted.json()));
    tokens.set(account.email, { token, until: Date.now() + 50 * 60_000 });
  }
  const response = await fetch(
    `https://us-documentai.googleapis.com/v1/${processor}:process`,
    {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        rawDocument: {
          content: Buffer.from(pdf).toString("base64"),
          mimeType: "application/pdf",
        },
      }),
    },
  );
  if (!response.ok) {
    // A token that was turned down isn't offered again.
    if (response.status === 401) tokens.delete(account.email);
    return turnedAway(response.status, `Document AI: HTTP ${response.status}.`);
  }
  // Each page says which stretches of the document's text are its own.
  const { document } = zDocument.parse(await response.json());
  return {
    got: "text",
    pages: document.pages.map(({ layout }) =>
      (layout?.textAnchor.textSegments ?? [])
        .map(({ startIndex, endIndex }) =>
          document.text.slice(startIndex, endIndex),
        )
        .join(""),
    ),
  };
}
