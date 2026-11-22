# Forms

An official form, fetched from its authority, filled in by code from what the
person said, and read back to prove it says that.

## What has to be true

1. It's the form the authority publishes, and we can say which bytes.
2. Every value on it is one the person gave, in the place that asks for it.
3. Nothing is cut short to fit, and nothing is made up to fill a box.
4. What couldn't be written is said, not hidden.

## A form is a list of places

`pdf.ts` reads a PDF into **targets**: places a value can go, each with a page,
a rectangle, a kind (text or tick box) and the words printed beside it.

- **A fillable PDF** gives its fields.
- **A flat PDF** has none, so they're found on the page: the space above a ruled
  line, up to the caption printed in it, between any uprights; and small
  squares, for tick boxes.

From there the two are treated alike. A field is set and a region is drawn into;
a field is read back and a region's text is read off the page from inside its
rectangle.

The flat reading is scored against the truth: `pdf.test.ts` flattens the real
IRS Form 8822 and checks the blanks found against where its fields were.

## Fetching, and what "current" means

`forms` is a small registry, added to by hand: a code, and the address the
authority publishes it at (`sourceUrl`, plus any `alternateUrls` on the same
authority's sites). Only an address on a government's own https site is accepted
(`mayRead`, see [VOUCHING.md](./VOUCHING.md)).

What's needed is the exact bytes the authority publishes, and to be able to say
where they came from. `sources.ts` tries the ways to get them in order, cheapest
first, and stops at the first usable PDF:

1. **A plain request** to each address.
2. **A real browser** opening each address (`browser.ts`), for sites a plain
   request can't read. It uses a hosted browser (Browserbase) and needs
   `BROWSERBASE_API_KEY` on the deployment. Set `BROWSERBASE_PROJECT_ID` to
   choose a project; otherwise Browserbase infers it from the API key. Without
   the API key this step is skipped.

A person is never asked to fetch a form for us. Every try is kept on the form
(`lastFetch`), so one that can't be reached says which ways were tried and why
each failed, and an edition records how it was got (`obtained`).

The browser uses the same session settings as the EasyGov repo: Browserbase's
managed proxies, automatic CAPTCHA solving and ad blocking. It waits up to 60
seconds for a download, then releases the session on success or failure; the
provider also caps the session at 90 seconds. These features use the Browserbase
account's plan and usage allowance. If a site still refuses access or no file
arrives, the attempt is recorded as a failure.

Whatever way the bytes come, they have to be a PDF and name the form they're
meant to be (`namesForm`): a site answering with some other document doesn't
become an edition.

**Protected files.** Many government forms are encrypted without a password:
anyone can open them, and the file says what may be done with it. `open.ts`
reads that. Where the file allows its forms to be filled in, the protection is
removed so it can be (`opened` on the edition). Where it needs a password, or
doesn't allow filling, the form is refused and says why.

- **An edition is its bytes.** `formEditions` is keyed by SHA-256. The same
  bytes again only refresh `checkedAt`; different bytes are a new edition, and
  the old one stays for the cases built on it.
- **The printed revision is read off the form** ("Rev. February 2021").
- **Published isn't the same as accepted.** Every edition starts `unconfirmed`.
  `confirmed` needs a page from the authority saying so, kept as evidence.
  Nothing sets it yet.

## Reading a form's identity

A file's words are asked for in one place, and kept with where they were read
from (`Words` in `words.ts`; the plan is in [WORDS.md](./WORDS.md)). What says a
file is the form is kept with the answer (`namedBy` in `sources.ts`), through to
the packet's form: the source of the words that name it, or the link.

- **Its text** (`"text"`). Its own words name the form (`namesForm`): those of
  the first page that has any, read by pdfjs.
- **Its XFA** (`"xfa"`). A form drawn only by XFA (Canada's IMM 5257) shows
  every reader but Adobe's a single "Please wait..." page. Its words are in its
  XFA template and data, and pdfjs reads them from there (`enableXfa`) as the
  pages they make, and says it did (`isPureXfa`). They are used like any page's:
  for which form it is, and its revision, language and expiry. No dependency was
  added.
  - **An XFA form can't be filled.** It has no fields a PDF library can set, and
    no page to draw on. It is found, and confirmed where its link is, with no
    places: the person completes it by hand, in Adobe's reader. Filling XFA
    isn't built.
- **Words a reader read off it** (`"ocr"`). A scan has no words of its own: the
  UK's V62 is two pictures. Its first 3 pages are given to a reader
  (`reader.ts`), which gives back their words and nothing else. They name the
  form by the rule any words are held to.
  - **One reader runs**, chosen by `readerKind` in `convex/modelsForDemo.ts`
    (Document AI since 2026-11-22): a model through the gateway (`readerModel`),
    or Google's Document AI, which needs `DOCUMENT_AI_CREDENTIALS` (a service
    account's key file, whole) and `DOCUMENT_AI_PROCESSOR`
    (`projects/…/locations/us/processors/…`) on the deployment. There is no
    fallback from one to the other.
  - **Read once.** The words are kept with the file's hash. A read that didn't
    get an answer is tried again at the next ask; a packet may spend 3 reads.
  - **Never filled, and ranked last.** Its words have no place on the page, so
    it has no places. A file of the same form with words of its own is chosen
    over it, and the person is asked to check its edition.
- **The authority's link alone** (`"link"`). Only for a file nothing could read:
  no words on any page or in XFA, and no reader that answered. All of these have
  to hold:
  - the link was chosen as the form at 0.9 or surer (`VERY_SURE` in
    `case/locate.ts`);
  - its page and the file are on the packet's government's own vouched sites
    (`confirms`);
  - the page's words for the link, its own or its heading, print the form's
    whole code, by the rule a file's text is held to.

A file with words that don't name the form is refused, whatever links it.

A form named by its link alone is confirmed (`backed`), since the authority's
page links it. Nothing else is known of it, and it is treated so:

- **Ranking.** It has no revision, language or places. A file of the authority's
  own that prints a revision, and any readable English file with places, is
  chosen over it.
- **Edition.** Its revision and expiry can't be read, so the person is asked to
  check that it is the form, and the current edition, in its open item.
- **Filling.** It is never filled: no place on it says what goes there.
- **Later checks.** The pack keeps `namedBy`, so its weekly check accepts the
  address only while the file there still has no words.

## Mapping

A mapping says what goes in each target (`schema.ts`). Each entry is one of:

- `input`: an answer. A profile reading such as `fullName` is read from the
  profile; any other key is a question for the case, asked in the entry's
  `question`.
- `constant`: the same on every copy.
- `leave`: left for the person to complete, with why. `signature` is theirs to
  sign and date. `confidential` is a value we don't hold, such as a Social
  Security number.

A target with no entry stays blank.

**Tick boxes.** A box with an `input` also says when it's ticked:

| The boxes are                  | Each box has         | The answer is             |
| ------------------------------ | -------------------- | ------------------------- |
| Alternatives ("filing status") | `equals: <option>`   | one option                |
| "Check all that apply"         | `includes: <option>` | the options, comma-joined |
| One box on its own             | `equals: "yes"`      | `yes` or `no`             |

Boxes that share an input are one question. A pack on the form asks it once,
with the boxes as its choices (`mapping.ts:mappingQuestions`), and an answer has
to be among them. Where the PDF itself groups boxes under one field (a radio
group), `pdf.ts` reads each box's `option` and turns on exactly one.

- **A model drafts it** from the printed words (`agents.ts:proposeMapping`).
- **A person reviews it.** Only a `reviewed` mapping fills a case.
- **It's frozen with the bytes.** A new edition starts again.
- **Once a pack fills the edition, it stays reviewed.** The mapping can be
  corrected and saved as reviewed again, but not saved unreviewed, and the
  targets can't be re-read (`fetchForm` with `reinspect`): cases pinned to the
  pack fill the form from it.

`mapping.ts` turns a mapping and the answers into values, in code. No model runs
when a form is filled.

## Filling and checking

`fillPdf` writes; `verifyPdf` reads the result back.

- A value longer than its box takes, or too wide for its space at a readable
  size, is **left out and reported**. Half an address is worse than none.
- What was written is read back and compared. Anything that doesn't match is
  reported with the omissions.

## In a case

`data.ts:publishPack` makes a shared pack for a reviewed edition: its inputs are
what the mapping reads. A case on that pack is answered from the profile where
the keys are readings, asks the rest, and after the answers are in the workflow
fills the form (`fillForCase`). The review shows the PDF
(`data.ts:documentUrl`), what was left out, and what to write by hand
(`artifact.document`).

## What isn't here yet

- **Scanned pages.** A flat PDF with no text or line drawing needs a vision
  model to find its blanks.
- **Dropdowns and list boxes.** Left alone.
- **Conditional boxes.** "Spouse's name" is left blank for everyone, not asked
  of those it applies to.
- **Comb fields and split boxes** beyond what a reading already gives
  (`mailingZip`, `mailingZip4`).
- **A download that starts from a page.** The browser opens the file's own
  address; it doesn't yet click through a landing page to find it.
- **Confirming currency** from the authority's page.
- **Confidential values, entered once.** A Social Security number is left for
  the person today. Better: they type it when the form is filled, it's written
  into the PDF, and it's never stored.

## The files

How a form is confirmed as a government's own, in any country, and the stages of
that work: [VOUCHING.md](VOUCHING.md).

| File         | Job                                                                         |
| ------------ | --------------------------------------------------------------------------- |
| `pdf.ts`     | Pure: read a PDF's places, fill them, read them back                        |
| `mapping.ts` | Pure: a mapping and answers to what goes where                              |
| `schema.ts`  | The registry, editions, targets and mappings                                |
| `data.ts`    | Registry and edition queries, saving a mapping, publishing                  |
| `sources.ts` | Pure: the ways to get a form's bytes, tried in order                        |
| `words.ts`   | Pure: a file's words, and where they were read from (see `WORDS.md`)        |
| `reader.ts`  | In Node: a file's words asked for in one place; reading a scan's            |
| `open.ts`    | In Node: read what a protected file allows, and open it if it may be filled |
| `browser.ts` | In Node: open an address in a hosted browser, collect the file              |
| `actions.ts` | In Node: fetch from the source, fill for a case                             |
| `agents.ts`  | The model step: draft a mapping from the printed words                      |
| `sites.ts`   | Whose government each site is; which form is confirmed (see `VOUCHING.md`)  |
