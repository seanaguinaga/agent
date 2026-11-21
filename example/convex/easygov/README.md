# easygov

A small government-case pipeline. The person drives it, and each thing the case
does for them is **one short durable workflow** that reads top to bottom and
ends. Nothing runs, loops or waits while it's the person's turn:

1. **Agree on what to do.** Intake answers each chat message until it knows the
   goal. The selection agent proposes a process pack, and the case waits for the
   person to accept it. Rejecting it, or a clarifying question, goes back to
   intake.
2. **Collect, build, review.** The case waits for the pack's answers and files,
   builds the document, and waits for the person to accept it. Editing an answer
   in review goes around again.
3. **Finish.** If the pack offers a legal referral, ask the person whether to
   share the case, then prepare delivery if the pack says so.

Read `nextWork` in `case/state.ts` first, then `case/workflow.ts`: together they
are the whole flow. The workbench in `example/ui/easygov/` drives these same
public functions. A case can fill official PDFs and download the packet as a
ZIP.

A case can also **start on a pack**, from a landing page: `createCase` with a
`packId` skips step 1 and makes no model call. See
[Starting from a landing page](#starting-from-a-landing-page).

## From a new request to a packet

On a library miss, the research action finds the authority and its source
material. The draft records route decisions, eligibility conditions with
sources, supporting evidence, official forms and filing order. Independent form
preparations run in parallel. Each uses a fetched edition, an immutable field
mapping and the questions it needs. Accepting a draft with a compiled form saves
a private reusable pack. The case retains its own pinned definition. A curated
form pack still uses its reviewed mapping.

Chat and uploaded files can suggest reusable profile facts. The person confirms
them in the case. Contradictory suggestions stay open for an answer. A route's
forms and letter follow the answers to its decision questions.

In the workbench, **Prepare with what I have** builds a partial packet and lists
missing answers and evidence. **Reassess packet** prepares a new revision on the
same case and can retry incomplete research. **Download packet** packages the
applicable PDFs, letter, evidence and instructions. The lawyer receives the
version the person shared. The firm desk can request information and the person
can reply on the case. The example uses a fixed test identity.

## The files

| File               | Job                                                                      |
| ------------------ | ------------------------------------------------------------------------ |
| `case/workflow.ts` | The case's workflows, what starts them, and their `onComplete`           |
| `case/data.ts`     | The queries and mutations the workflows call                             |
| `case/state.ts`    | Pure: what the case's fields mean: `phase`, `waitingFor`, `nextWork`     |
| `limits.ts`        | What a case may cost: the rate limits, and the agents' usage handler     |
| `case/events.ts`   | What a person can send, when it's taken, and what it writes              |
| `case/evidence.ts` | Attached files: adding, removing, and reading each with a model          |
| `case/public.ts`   | What a client calls: `createCase`, `getCase`, `sendMessage`, `sendEvent` |
| `operators.ts`     | Who may run the forms registry, the evals and the test pages             |
| `packs/public.ts`  | What a landing page reads: the shared packs, one page each               |
| `case/agents.ts`   | The intake and selection agents                                          |
| `case/schema.ts`   | Every case field and every event                                         |
| `case/answers.ts`  | Pure helpers over the answers                                            |
| `packs/`           | The process pack library: search, save, versions (see its README)        |
| `firms/`           | The law firms, and the cases shared with them (see its README)           |
| `schema.ts`        | The tables                                                               |
| `forms/`           | Official forms: fetched, mapped, filled and read back (see its README)   |
| `profile/`         | The person's own facts, read by every form (see its README)              |
| `evals/`           | How often the models get each step right (see its README)                |
| `dev.ts`           | Seeding and inspection for the test pages; not for production            |
| `review.ts`        | What people corrected lately, beside what each agent step cost           |
| `autopilot.ts`     | Pure: plays the person's part, for the test pages and the evals          |

## How it fits together

**The case in the table is the truth.** A person's event only writes the case.
After each write, and whenever a workflow ends, `advance` (in
`case/workflow.ts`) asks `nextWork(case)` what the case needs now and starts it:
one chat reply (`intake`), one proposal (`propose`), reading the conversation
for answers (`suggest`), revisiting a draft (`revise`), building the document
(`build`), or ending the case. Most often the answer is nothing: it's the
person's turn, and nothing runs until they write again. At most one workflow
runs per case, recorded as `run`. Nothing lives only in a workflow's history,
so:

- `sendEvent` and the workflows can't disagree about where the case is.
  `sendEvent` accepts an event only while `waitingFor(case)` says the case waits
  for it, and `nextWork` is worked out from the same fields.
- A retry drops the failed workflow and starts what the case needs now. That
  finds the goal, the pack and the answers already there, and carries on from
  where the case is. It's also how to recover a case whose workflow a code
  change broke.
- A retry can't forget anything, because no count lives in a workflow.

**The person takes as many turns as they like; what's limited is the cost.**
Rejecting a proposal or chatting on never stops a case. `limits.ts` holds the
budgets, kept by the Convex rate limiter:

- Chat messages per person. Over it, `sendMessage` is refused with the time to
  retry.
- Model work started, and tokens spent, per person and for everyone together (a
  guest key costs nothing to make, so a limit per person alone caps nothing).
  Over a budget, the work is `delayed` and starts when its turn comes:
  `run.state` is `delayed`, with `until`. Tokens are charged by the agents'
  usage handler once a call's usage is known, so a budget can go into debt, and
  the next work waits that out.
- Every model call is charged: an agent's by its usage handler, any other
  (`proposeMapping`, `addressFromText`, the evals' judge) by `chargeUsage`. The
  two actions a person can call that go straight to a model (`parseAddress`,
  `draftMapping`) are refused when the budget is spent.
- Work one case starts. No person edits that fast, so it's a runaway: the case
  parks as `failed` until someone sends `case.retry`, and an error is logged
  (`easygov runaway: ...`) for an operator's alerts.
- An eval's case is `unmetered`: its work skips these limits (its tokens are
  still charged). Only the eval runner sets that, from an internal mutation.
- `builds`, a count on the case: documents built since one was accepted. A build
  that comes out behind the answers starts another with no person involved, so
  past the limit the case stops.

**Every case is in one named phase.** `phase(case)` in `case/state.ts` works it
out from the case's fields; it isn't stored, so it can't fall behind them. In
order: `intake`, `proposing`, `pack`, `suggesting`, `answers`, `filling`,
`review`, `consent`, `finishing`, then `done`, `stopped` or `canceled`, with
`failed` while the workflow waits for a retry. The person acts in five of them,
and `waitingFor` is the phase's name for what they're asked (`intake` waits for
a `goal`); in the rest the workflow is working and `waitingFor` is null.
`getCase` returns both, and the workbench shows the phases as a timeline.

What a case holds says which of several things it is, not which fields happen to
be set: a selection's `kind` is `pack`, `draft` or `referral`, a rejected one
says whether the `person` turned it down or the agent asked a `clarification`,
and `run` is the work in hand, `running`, `delayed` or `failed` (unset while the
case only waits for the person).

**The agents save nothing themselves.** Each model call runs as a retried action
and returns a result; the workflow's next mutation decides what to keep. A
retried call can't leave a duplicate in the thread.

**A fact records what it was made from**, so it's out of date on its own:

- `goal.version` goes up each time a goal is set. A pack selection records the
  `goalVersion` it was made for; one for an earlier goal counts as none.
- `artifact.fingerprint` is a SHA-256 of the answers and files the document was
  built from; `accepted.fingerprint` is the one the person accepted.
- `seq` goes up on every write. `sendEvent` takes the `expectedSeq` the sender
  last saw, so a decision made on an out-of-date screen (accepting, sharing) is
  refused. An answer or a file is taken either way: it writes its own key.

**The person isn't asked twice.** When a proposal is accepted, the workflow
reads what the person already said (their chat and their goal) for answers to
the pack's questions. What it finds comes back as `getCase.suggestions`: not
answers until the person sends `answers.accept` (or sets them one by one). Only
what they plainly said is suggested; a guess would end up in their document. A
case started on a landing page has said nothing, so it skips this.

**Nothing is shared without a yes.** When a pack's referral applies, the case
waits for `consent`. `referral.share` copies what the person accepted into
`referrals`, as it was at that moment; `referral.reject` ends the case with
nothing copied. Whether the referral applies is settled once, when the artifact
is accepted. One firm that covers the referral then accepts it, and only that
firm reads it; the person can take it back until then (`withdrawReferral`), and
the case's referral then reads `withdrawn`.

**A lawyer can be asked for before the packet is done.** From the proposed
process on, `referral.request` shares the case as far as it has got: asking is
the yes. The person carries on with it, and accepting the document later doesn't
ask again. `getCase.lawyer` says whether the event is taken now and why a page
might suggest it: the process is a `contested` one that lawyers take, or a
`decision` against the person has come in. A file's reading marks it `adverse`
when it's a denial, a rejection or a demand; on a done case such a follow-up is
what makes the suggestion, and it's shared with the rest when the person asks. A
guest claims the case first.

**A firm sees what a case is worth before it accepts.** A preview carries the
`stage` the case was shared at, the amount at stake as a band (never the
figure), and the days left to act. A pack's referral check passes on `when` or
on any of `orWhen`, since a case is rarely worth a lawyer for one reason only. A
referral no firm takes within `OPEN_DAYS` expires (a cron runs
`firms/data:expireReferrals`): the case's referral reads `expired`, its history
says so, and the person can ask again.

**Failures park the case.** If the workflow fails, `onComplete` records the
error (`run.state` is `failed`) and the case takes no events until the person
sends `case.retry` (start the work again) or `case.stop` (stop). `case.cancel`
works at any time.

## What went wrong lately

Each agent call is traced (see `debugging/spans.ts`), and the case history
records each time a person corrects a model: `pack.rejected`, `answer.changed`
(an answer changed in review, or a first answer other than the one a model read
from the chat or a file; only the question's key is kept) and
`artifact.reassessed`. One query puts the two side by side, leaving out the
evals' own cases:

```sh
npx convex run easygov/review:lastDays '{"days":7}'
```

It gives each correction with example cases and threads, the questions whose
answers were changed most, and each easygov agent step's count, failures, time
and tokens. Read the example threads before changing a prompt, then make the
failure an eval case (see `evals/`) so the fix shows in a run.

## What a page reads

Everything a person's page shows comes from `case/public.ts`, for the signed-in
account or the guest holding the case's key:

- `listCases` is their cases, newest first, a page at a time.
- `getCase` is one case, ready to render: `phase` and `waitingFor` say which
  screen, `asks` is each question with its wording, kind, choices, answer,
  suggestion and conflict, and `files` is each document the process asks for
  with how many are attached. A page needn't read the pinned definition.
- `listMessages` is the conversation, for `useUIMessages`. It takes the case and
  its `threadId`, and refuses a thread that isn't the case's.
- `listHistory` is what happened, in order.

The forms registry, the evals and `dev.ts` are for operators (`operators.ts`):
the accounts named in `EASYGOV_OPERATORS`, or the example's fixed test identity
while that's unset. A case's own work reaches forms through internal functions,
so it needs no operator.

## Try it from the dashboard

First seed a pack. Run `easygov/packs/data:createPack` with the `irs8822`
definition from `packs/packs.testkit.ts` (it has no `ownerId`, so it's shared).
The agent proposes it when the goal matches; without a seeded match it drafts a
one-off process for you to review instead, which runs on that case and isn't
saved.

Run each function from the dashboard's Functions page. Every `sendEvent` needs
the case's current `seq`, so read it with `getCase` first. `getCase` also says
what the case is `waitingFor`.

1. `easygov/case/public:createCase` with `{}`. Copy the returned id.
2. `easygov/case/public:getCase` with `{ "caseId": "<id>" }`. It's waiting for a
   `goal`.
3. Chat with intake: `easygov/case/public:sendMessage` with
   `{ "caseId": "<id>", "text": "I moved and need to tell the IRS", "messageKey": "m1" }`
   (a new `messageKey` for each message). Once intake knows the goal, a pack is
   proposed and the case waits for the `pack`. (Or skip the chat: send
   `goal.set` below instead.) Chat is for intake only: once a pack is accepted,
   `sendMessage` is refused.
4. `easygov/case/public:sendEvent` with each of these events in turn, as
   `{ "caseId": "<id>", "expectedSeq": <seq>, "event": <event> }`:

   ```json
   { "type": "goal.set", "goal": "I moved and need to tell the IRS" }
   { "type": "pack.accept" }
   { "type": "answers.set", "key": "fullName", "value": "Ada Lovelace" }
   { "type": "answers.set", "key": "oldAddress", "value": "1 Old Road" }
   { "type": "answers.set", "key": "newAddress", "value": "2 New Street" }
   { "type": "artifact.accept" }
   ```

5. `getCase` now shows `status: "done"` and `delivery.status: "prepared"`.

The `eeocCharge`, `vaDecisionReview` and `uiAppealCa` definitions are contested
matters with deadlines and several-answer referral checks. Their dates and form
numbers were drafted from the authorities' public guidance and haven't been
reviewed by a lawyer.

Seed the `ssaAppeal` definition and state an SSA appeal goal to see a referral:
answering `wantsRepresentation` with `yes` makes the case wait for `consent`
after acceptance, and `{ "type": "referral.share" }` adds a row to `referrals`.
The `caseEvents` table is the case's history.

## Starting from a landing page

A shared pack is a page people can land on: a form, a letter, a complaint.

1. `easygov/packs/public:listLandings` lists the shared packs, and
   `easygov/packs/public:getLanding` describes one: its questions, the files it
   asks for, and its deadline. Neither needs a sign-in. A link to an older
   version of a pack shows the current one.
2. `createCase` with `{ "packId": "<id>", "source": "<page name>" }` starts a
   case on that pack. It waits for `answers` straight away. `source` is kept on
   the case, and on any referral, to tell which pages lead to which.
3. Add `"guestKey": "<a long random string>"` to start without an account. Pass
   the same key to `getCase`, `sendEvent`, `sendMessage` and `createUploadUrl`.
   It's the only way back to the case until `claimCase` moves it to the
   signed-in account. A guest can't share a case with a lawyer; they claim it
   first.
4. For each file the pack asks for, call `createUploadUrl`, post the file to it,
   and send `{ "type": "evidence.add", "key": "<key>", "storageId": "<id>" }`.
5. `getCase` returns the `deadline` once the answer it's counted from is in, and
   `artifact.letter` once the document is built, if the pack writes one.

The `wageClaim` definition in `packs/packs.testkit.ts` uses all of it.

## Files

A person attaches files in three situations. All use the same two calls:
`createUploadUrl`, then `evidence.add` with the storage id the upload returns.
The file goes from the browser straight to storage, so its size isn't bound by a
function's arguments, and `createUploadUrl` checks who's asking.

- **To start the case.** While the case waits for a goal, attach the letter or
  notice with no `key`. A model reads it, what it states goes into the
  conversation as the person's message, and intake answers that: the case can
  start from the letter alone. Its facts are later offered as answers.
- **To support it.** Until the document is accepted, attach a file the pack asks
  for (with its `key`) or anything else (without). Several files can share a
  key, such as a letter photographed page by page. `evidence.update` says which
  of the pack's documents an attached file is, and `evidence.remove` takes one
  off. Like an answer, a file changed in review rebuilds the document.
- **After filing.** A `done` case still takes `evidence.add`, with no key: the
  receipt, or what the authority sent back. These are follow-ups. They aren't
  part of what was accepted, and aren't shared with a lawyer.

Each PDF, image or text file is read once (`case/evidence.ts`). `read.summary`
says what the file is and the facts it states, and `read.answers` holds the
pack's questions it plainly answers. Those show up in `suggestions` for the
person to accept; nothing a file says is filled in for them. Other kinds of
file, and ones over 10 MB, are kept but not read. A case holds up to 30 files of
up to 20 MB each. `getCase` returns a link to each in `evidenceUrls`.
