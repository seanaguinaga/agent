# packs/

**Which saved process pack fits this request?**

A process pack is a reusable definition of one government process: a title and
description, where it applies, the questions to ask (`inputs`), and the
checklist it produces. It can also name files to attach, a deadline, a letter to
write, a legal referral to offer, and a delivery channel (see
[What a pack can ask for](#what-a-pack-can-ask-for)). Every pack is a row in
`processPacks`; none are defined in code.

| File                | Touches the database? | Job                                                 |
| ------------------- | --------------------- | --------------------------------------------------- |
| `schema.ts`         | no                    | The table, and jurisdiction and form-number helpers |
| `data.ts`           | yes                   | `findMatch` (search) and `save`                     |
| `public.ts`         | yes                   | What a landing page reads: the shared packs         |
| `packs.testkit.ts`  | (tests)               | Example packs (IRS 8822, SSA appeal, wage claim)    |
| `packs.test.ts`     | (tests)               | Search, saving, duplicates, versions                |
| `irs8822.test.ts`   | (tests)               | A whole case on the IRS pack                        |
| `ssaAppeal.test.ts` | (tests)               | A whole case with a conditional referral            |

The agent that proposes a pack is in `case/agents.ts`. This folder is only the
library it searches.

## A pack has no key

A live run showed why: the same request came back once as
`us-ca/state-court/wage-garnishment-notice/review` and once as
`us-ca/courts/wage-garnishment/understand-notice`. A key the model writes can't
identify anything. So labels only feed search, and a model compares the
candidates. Selection is three model calls:

1. **Read the request.** Is it a process, a request for legal advice, or
   unclear? Where does it apply (`us`, `us/ca`, `us/ca/alameda`), who handles
   it, and which form numbers does it mention? Advice becomes a legal referral;
   unclear goes back to intake with one question.
2. **Compare candidates.** `findMatch` searches current packs in that
   jurisdiction and every one containing it (a county request also finds state
   and federal packs), shared and the person's own. The model picks one by
   number, or none.
3. **Draft** a new pack when none fits, for the person to review.

## Saving a pack

Use the internal `easygov/packs/data:save` mutation with a title, description,
aliases, a `jurisdiction` path, an optional `authority`, any official `forms`,
the inputs, and optionally a `referral` (with a `when` on one answer) and a
`delivery` channel.

- Leave out `ownerId` to save a shared pack every case can find. With one, only
  that person's cases find it.
- `save` searches for similar current packs first: ones that name the same form,
  or share at least two telling words. If it returns `reviewDuplicates`, reuse
  one of them, or list their ids in `reviewedPackIds` and save again to say this
  one is different.
- A saved row never changes, and cases keep the id they pinned. To fix or update
  one, save the next version with `supersedes: <id>`. The old version stops
  being found, and cases already running on it keep it.

## When no saved pack fits: a draft

Selection first reads the authority's own website (a search-backed model,
`researchModel` in `modelsForDemo.ts`), then drafts a process from what it
found: a checklist, and a letter if the process calls for one. The pages it read
are kept in `output.sources`. If the search fails, the checklist only says what
to verify, and has no sources. A draft is one model's unreviewed guess, so it is
**never saved as a pack**. It runs on the case that asked for it and stays there
(`processPack.draft`), where it also records what people asked for that no pack
covers. A person turns a good one into a shared pack with `save`.

1. After intake, read `getCase.processPack.draft` to review the checklist and
   the questions.
2. Send `{ "type": "processPack.confirm" }` with the case's current
   `expectedSeq`, which makes sure you confirm the proposal you read. The case
   pins the draft's inputs; there is no pack id.
3. The case collects the answers, builds the checklist and letter, and waits for
   review. A draft with no letter asks nothing and goes straight to review.

A draft's questions are its letter's `{{placeholders}}`, plus up to three about
the person's situation that the checklist is tailored by (`output.tailorBy`).
Whatever else the model asks is dropped: anything to look up belongs in the
checklist.

## What a pack can ask for

- **`documents`**: files to attach, each `required` or not. A case waits for at
  least one file for each required one, along with the answers. The person can
  attach other evidence too, which no pack needs to list.
- **`deadline`**: `{ label, fromInput, days }`. The date is `days` after the
  date answered for `fromInput`, which must then be a date (YYYY-MM-DD).
- **`output.letter`**: text with `{{inputKey}}` placeholders, filled in from the
  answers when the document is built.
- **`output.tailorBy`**: input keys about the person's own situation ("online or
  by mail?"). Once they're answered, a model picks which checklist steps apply,
  and the rest are left out of the person's document (`artifact.checklist`). It
  only chooses among the pack's steps: it can't write one. If it fails, every
  step is kept.
- **`referral`**: `{ kind, when }`. `when` is one check on one answer: `equals`
  some text, `atLeast` a number, or `withinDays` (the date answered is today or
  at most that many days ago). When it passes at approval, the person is asked
  whether to share the case. Without `when` they're always asked.

`save` refuses a pack whose deadline, referral or letter names an input the pack
doesn't have. It also refuses an input nothing reads: each one must appear in
the letter, the deadline or the referral check, unless the pack names the
`forms` it fills in.

## The parts that are hard to follow

- **The jurisdiction chain**: `us/ca/alameda` is searched as itself, then
  `us/ca`, then `us`, narrowest first.
- **`authority` and `forms` are search words, never filters**, since people and
  models name them differently.
- **`searchText`**: derived from the definition, because a search index takes
  one text field.
- **`MAX_CANDIDATES = 5`**: few enough that a person can review all of them.
  Already-reviewed packs are read past, so they can't hide new ones.
- **`status: "superseded"`**: only `current` packs are found.
