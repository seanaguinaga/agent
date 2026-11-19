# packs/

**Which saved process pack fits this request?**

A process pack is a reusable definition of one government process: a title and
description, where it applies, the questions to ask (`inputs`), the steps to run
(`plan`), and the checklist it produces. Every pack is a row in `processPacks`;
none are defined in code.

| File                | Touches the database? | Job                                                  |
| ------------------- | --------------------- | ---------------------------------------------------- |
| `schema.ts`         | no                    | The table, and jurisdiction and form-number helpers  |
| `data.ts`           | yes                   | `findMatch` (search) and `save`                      |
| `packs.testkit.ts`  | (tests)               | Two example packs (IRS 8822, SSA appeal) and seeding |
| `packs.test.ts`     | (tests)               | Search, saving, duplicates, versions                 |
| `irs8822.test.ts`   | (tests)               | A whole case on the IRS pack                         |
| `ssaAppeal.test.ts` | (tests)               | A whole case with a conditional step                 |

The agent that proposes a pack lives with its stage, in
`stages/selectProcessPack/agent.ts`. This folder is only the library it
searches.

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
the inputs and the plan.

- Leave out `ownerId` to save a shared pack every case can find. A person's own
  packs are saved when they confirm a draft.
- `save` searches for similar current packs first. If it returns
  `reviewDuplicates`, reuse one of them, or list their ids in `reviewedPackIds`
  and save again to say this one is different.
- A saved row never changes, and cases keep the id they pinned. To fix or update
  one, save the next version with `supersedes: <id>`. The old version stops
  being found, and cases already running on it keep it.

## Confirming a newly drafted pack

1. After intake, read `getCase.processPack.draft` to review the proposed title,
   questions, plan and checklist.
2. Send `{ "type": "processPack.confirm" }` with the case's current
   `expectedSeq`, which makes sure you confirm the proposal you read. The
   mutation checks for similar packs, saves the draft for this owner, and pins
   it to the case in a single transaction.
3. If `processPack.duplicateReview` appears, pick a listed pack with
   `{ "type": "processPack.useExisting", "packId": "..." }`, or, if they're
   different processes, resend `processPack.confirm` with the listed ids in
   `reviewedPackIds` and the latest `expectedSeq`.
4. After confirmation the case collects its answers, builds the checklist, and
   waits for review. A later case can find and pin the saved pack.

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
