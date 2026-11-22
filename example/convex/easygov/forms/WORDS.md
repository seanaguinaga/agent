# A file's words

One question, asked in one place: _what are this file's words?_ The caller never
sees how they were got. The PDF's own text, its XFA and OCR are three ways to
the same answer, and a new way is one more member of a union.

This is the plan and its record. Tick a stage when it lands, and write down what
it found. Paths are under `example/convex/easygov`.

## Stages

- [x] **1. `Words`, with no OCR.** `wordsIn`, `vWords`, `namedBy` over words,
      the migration. Every existing test passes; a scan is `none/noReader` and
      is still named by its link.
  - `"xfa"` has its own `from`: pdfjs says a form is drawn only by XFA
    (`isPureXfa`), at no cost. A form named by its XFA is never compiled.
  - Rows kept before are read as they will be migrated (`wordsOf` in
    `forms/data.ts`), so nothing waits on the migration. One that was XFA
    becomes `"text"`: its row can't say. Run once per deployment, then make
    `words` required and drop `opening` and `wordsOf`:
    `npx convex run easygov/forms/data:wordsFromOpening '{"cursor":null}'`
- [ ] **2. `transcribe`, with two readers.** Gemini 2.5 Flash through the
      gateway, and Google Document AI. Proof: tests for each reader and each
      outcome; a scan named by `"ocr"`; a held scan transcribed once; the
      Document AI token request checked against a test key pair; the 3-page cut;
      the `reads` budget; `transcribe` never given the form's code.
- [ ] **3. Measure, then choose which reader runs.** By the owner: one `world`
      eval run per reader. V62, SA100 and IR3 should be named by OCR; Document
      AI's seconds measured. Both readers stay in the switch (see the answers).
- [ ] **4. Fetch ways** (survey, row 1). Proof: `fetch.test.ts` unchanged and
      passing.
- [ ] **5. Decision call** (survey, row 2).
- [ ] **6. Retire `"link"`?** Not planned: link-only naming stays as the
      fallback (see the answers). Revisit only if stage 3 shows no file needs
      it.

## The surface

```ts
// forms/words.ts
export type Words =
  | { from: "text" | "xfa"; opening: string }
  | { from: "ocr"; opening: string; by: string } // by: which reader, for evals
  | { from: "none"; why: "blank" | "tooLarge" } // settled: read, nothing there
  | {
      from: "none";
      why: "noReader" | "unspent" | "refused" | "unavailable" | "failed";
      note: string;
    };

/** Pure: the words a file carries itself. */
export function wordsIn(pages: string[], xfa: boolean): Words | "unread";

/** Pure: whether these bytes need never be read again. */
export function settled(words: Words): boolean;

/** The one place. Held by sha256, else the file's own, else transcribed. */
export async function fileWords(ctx, file, mayRead: boolean): Promise<Words>;
```

`wordsIn` takes what `inspectPdf` already parsed, not the bytes: a second parse
of a 20 MB file costs memory and compute for nothing.

## The readers

Used only when `wordsIn` says `"unread"`:

```ts
// forms/reader.ts
export type Reader =
  | { kind: "model"; model: LanguageModel } // any gateway model
  | {
      kind: "documentAi";
      processor: string;
      account: { email: string; key: string };
    };

export type Transcript =
  | { got: "text"; pages: string[] } // words only: no field for a code
  | { got: "refused"; why: "quota" | "denied"; note: string }
  | { got: "tooLarge" }
  | { got: "unavailable"; note: string } // timeout, 5xx
  | { got: "failed"; note: string };

export async function transcribe(ctx, reader, pdf): Promise<Transcript>;
```

- **One switch.** `transcribe` switches on `reader.kind`; a pure `wordsFrom`
  maps a transcript to words with a second switch. Each declares its return type
  and has no `default`, so a missing case fails to compile. A new provider is
  one member, one case, one `viaX`.
- **Words only, by the type.** A transcript holds page strings and nothing else.
  `transcribe` is never told which form is wanted, so a model can't echo the
  code. Identity and facts stay in `namedBy`, `revisionOf`, `languageOf` and
  `expiredBy`.
- **Pages sent: the first 3**, cut with pdf-lib before the switch, so every
  reader gets the same small file. Identity comes from the first page with
  words; a picture cover may precede it. Finding blanks on a scan is out of
  scope.
- **One 30 s timeout, no retry inside.** Words that aren't settled are tried
  again at the next ask, as `refused` and `busy` already are.
- **Budget.** A `reads` kind in `Cost`; a packet may spend 3. It is taken up
  front and given back if unused, like downloads. The model reader also charges
  its tokens (`chargeUsage`).
- **Document AI, with no dependency.** A JWT signed with `node:crypto`,
  exchanged at `https://oauth2.googleapis.com/token`, then a POST of
  `{rawDocument}` to
  `https://us-documentai.googleapis.com/v1/{processor}:process`. 429 is quota;
  401 and 403 denied; 413 too large; 5xx unavailable; anything else failed.

## What it replaces

- `Inspection.opening` goes. `inspectPdf` gives each page's words and whether
  the form is drawn by XFA. The rule "the first page with words, up to 12,000
  characters" moves into `wordsIn`, and serves OCR pages too.
- `opening` on a held file (`formAddresses`) becomes `words`. This is the cache:
  a file's words are kept by sha256 already. A held row is used again when its
  words are settled. Scans held before have no words and no reason; they migrate
  to `none/noReader`, so they are read once.
- `namedBy` takes words. `NamedBy` becomes `"text" | "xfa" | "ocr" | "link"`:
  the source of the words that named the file, or the link. `unfilled`
  (`case/locate.ts`) switches on it, so the compiler asks for each new case.
- "An XFA form is found, never filled" becomes a case on `"xfa"`, not something
  inferred from having no places.
- The seam in `ask` (`forms/actions.ts`) calls `fileWords` and nothing else.

## The owner's answers

1. **Both readers stay** as members of the switch. Only one runs at a time,
   chosen in code beside the other model settings (`convex/modelsForDemo.ts`).
   No automatic fallback for now.
2. **OCR words identify a form like any words.** The person is still asked to
   check the edition. A file with its own text or XFA ranks above an OCR'd copy
   of the same form.
3. **Link-only naming stays**, as the fallback when no reader answers.
4. **`"xfa"` gets its own `from`** only if pdfjs can cheaply tell XFA words from
   page text; otherwise it folds into `"text"`. _(Recorded in stage 1.)_
5. **The first 3 pages; 3 reads a packet.**
6. **Document AI location: `us`.**
7. **Existing rows are migrated**, not cleared: a paginated mutation that
   schedules itself, like `clearChosenAt` and `clearBacked`.
8. **Verify what tests can; flag the rest.**

Measured before building, in a scratch test: Gemini 2.5 Flash
(`google/gemini-2.5-flash`) reads PDF file parts through the gateway, 1.7 to 7.6
s a file, all correct. Document AI can't be run live until a processor is set
up: it is tested against a stand-in network only.

## Where else the pattern fits

A survey of the whole example, ranked. Two are worth doing (stages 4 and 5).

| #   | Place                | Now                                                                                                                                                                                        | Union and function                                                                                                                                             | Net lines | Risk                                |
| --- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ----------------------------------- |
| 1   | Fetch ways           | `forms/actions.ts`: two branches of a 260-line `ask`. One ends in a catch-all (`!== "body"` is refused). The other reports outcomes by throwing (`BrowserBusy`). Each calls `keep` itself. | `fetchVia(ctx, way, …): Promise<Fetched>`; `Fetched` is `body`, `unchanged`, `gone`, `unusable`, `refused`, `busy` or `unreachable`. One pure `kept(fetched)`. | about 0   | Medium. `fetch.test.ts` covers it.  |
| 2   | Decision call        | `decisions.ts` and `convex/decisions/jev.ts` hand-write the same gateway POST.                                                                                                             | One `askDecisions(state, questions)`.                                                                                                                          | about −15 | Low.                                |
| 3   | Ternaries on a union | `forms/actions.ts` (a held answer), `forms/sites.ts` (three places, one taking `{state: string}` and losing the union), `case/agents.ts`.                                                  | A switch each.                                                                                                                                                 | 0         | Low value. Only when touching them. |
| 4   | Registers            | `forms/sites.ts` is wired to CISA's.                                                                                                                                                       | A `Register` union, `parse(register, csv)`.                                                                                                                    | positive  | Only when a second register exists. |

Where it would not help:

- **Model choice** (`modelsForDemo.ts`): one value per job already; the AI SDK's
  `LanguageModel` is the interface.
- **Research and search** (`case/agents.ts`, `case/locate.ts`): one provider,
  answering prose. A union of one is over-abstraction.
- **Eval slices** (`evals/runner.ts`): `Record<Slice, fn>` is exhaustive
  already.
- **The suffix table** (`forms/governments.ts`): data, read by `governed`.
- **Delivery or notification channels:** none exist.
- **Already this shape:** `autopilot.ts`, and the site states in
  `forms/sites.ts`.

No shared helper. The convention: _a routing switch is the whole body of a
function with a declared return type, and has no `default`._ The compiler
catches a missing case. Add `exhaustive(x: never)` the first time a switch
returns nothing.
