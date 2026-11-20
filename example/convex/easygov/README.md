# easygov

A small government-case pipeline. Each case is **one durable workflow** that
reads top to bottom, like `workflows/chaining.ts`:

1. **Agree on what to do.** Intake chats until it knows the goal. The selection
   agent proposes a process pack, and the case waits for the person to accept
   it. Rejecting it, or a clarifying question, goes back to intake.
2. **Collect, build, review.** The case waits for the pack's answers and files,
   builds the document, and waits for the person to accept it. Editing an answer
   in review goes around again.
3. **Finish.** If the pack offers a legal referral, ask the person whether to
   share the case, then prepare delivery if the pack says so.

Read `case/workflow.ts` first: that is the whole flow. There is no UI and no PDF
filling here.

A case can also **start on a pack**, from a landing page: `startCase` with a
`packId` skips step 1 and makes no model call. See
[Starting from a landing page](#starting-from-a-landing-page).

## The files

| File               | Job                                                                    |
| ------------------ | ---------------------------------------------------------------------- |
| `case/workflow.ts` | The case's workflow, and how it waits for a person                     |
| `case/data.ts`     | The queries and mutations the workflow calls, and its `onComplete`     |
| `case/state.ts`    | Pure: what the case's fields mean, including `phase` and `waitingFor`  |
| `case/events.ts`   | What a person can send, when it's taken, and what it writes            |
| `case/files.ts`    | Attached files: adding, removing, and reading each with a model        |
| `case/public.ts`   | What a client calls: `startCase`, `getCase`, `sendMessage`, `send`     |
| `packs/public.ts`  | What a landing page reads: the shared packs, one page each             |
| `case/agents.ts`   | The intake and selection agents                                        |
| `case/schema.ts`   | Every case field and every event                                       |
| `case/answers.ts`  | Pure helpers over the answers                                          |
| `packs/`           | The process pack library: search, save, versions (see its README)      |
| `firms/`           | The law firms, and the cases shared with them (see its README)         |
| `schema.ts`        | The tables                                                             |
| `forms/`           | Official forms: fetched, mapped, filled and read back (see its README) |
| `profile/`         | The person's own facts, read by every form (see its README)            |
| `evals/`           | How often the models get each step right (see its README)              |
| `dev.ts`           | Seeding and inspection for the test pages; not for production          |
| `autopilot.ts`     | Pure: plays the person's part, for the test pages and the evals        |

## How it fits together

**The case in the table is the truth.** Every wait in the workflow is a query
over the case ("are all the answers in?"), and a person's event only writes the
case and nudges the workflow to look again (unless the case still waits for the
same thing: an answer that leaves others missing isn't news). Nothing lives only
in the workflow's history, so:

- `send` and the workflow can't disagree about where the case is. `send` accepts
  an event only while `waitingFor(case)` says the case waits for it, and the
  workflow's waits are worked out from the same fields.
- A retry restarts the workflow from the top. It finds the goal, the pack and
  the answers already there, and carries on from where the case is. That's also
  how to recover a case whose workflow a code change broke.

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
and `run` is the workflow `running` or `failed`.

**The agents save nothing themselves.** Each model call runs as a retried action
and returns a result; the workflow's next mutation decides what to keep. A
retried call can't leave a duplicate in the thread.

**A fact records what it was made from**, so it's out of date on its own:

- `goal.version` goes up each time a goal is set. A pack selection records the
  `goalVersion` it was made for; one for an earlier goal counts as none.
- `artifact.fingerprint` is a SHA-256 of the answers and files the document was
  built from; `accepted.fingerprint` is the one the person accepted.
- `seq` goes up on every write. `send` takes the `expectedSeq` the sender last
  saw, so a decision made on an out-of-date screen (accepting, sharing) is
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

**Failures park the case.** If the workflow fails, `onComplete` records the
error (`run.state` is `failed`) and the case takes no events until the person
sends `case.retry` (run again from the top) or `case.stop` (stop). `case.cancel`
works at any time.

## Try it from the dashboard

First seed a pack. Run `easygov/packs/data:save` with the `irs8822` definition
from `packs/packs.testkit.ts` (it has no `ownerId`, so it's shared). The agent
proposes it when the goal matches; without a seeded match it drafts a one-off
process for you to review instead, which runs on that case and isn't saved.

Run each function from the dashboard's Functions page. Every `send` needs the
case's current `seq`, so read it with `getCase` first. `getCase` also says what
the case is `waitingFor`.

1. `easygov/case/public:startCase` with `{}`. Copy the returned id.
2. `easygov/case/public:getCase` with `{ "caseId": "<id>" }`. It's waiting for a
   `goal`.
3. Chat with intake: `easygov/case/public:sendMessage` with
   `{ "caseId": "<id>", "text": "I moved and need to tell the IRS", "messageKey": "m1" }`
   (a new `messageKey` for each message). Once intake knows the goal, a pack is
   proposed and the case waits for the `pack`. (Or skip the chat: send
   `goal.set` below instead.) Chat is for intake only: once a pack is accepted,
   `sendMessage` is refused.
4. `easygov/case/public:send` with each of these events in turn, as
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

Seed the `ssaAppeal` definition and state an SSA appeal goal to see a referral:
answering `wantsRepresentation` with `yes` makes the case wait for `consent`
after acceptance, and `{ "type": "referral.share" }` adds a row to `referrals`.
The `caseEvents` table is the case's history.

## Starting from a landing page

A shared pack is a page people can land on: a form, a letter, a complaint.

1. `easygov/packs/public:landings` lists the shared packs, and
   `easygov/packs/public:landing` describes one: its questions, the files it
   asks for, and its deadline. Neither needs a sign-in. A link to an older
   version of a pack shows the current one.
2. `startCase` with `{ "packId": "<id>", "source": "<page name>" }` starts a
   case on that pack. It waits for `answers` straight away. `source` is kept on
   the case, and on any referral, to tell which pages lead to which.
3. Add `"guestKey": "<a long random string>"` to start without an account. Pass
   the same key to `getCase`, `send`, `sendMessage` and `uploadUrl`. It's the
   only way back to the case until `claimCase` moves it to the signed-in
   account. A guest can't share a case with a lawyer; they claim it first.
4. For each file the pack asks for, call `uploadUrl`, post the file to it, and
   send `{ "type": "evidence.add", "key": "<key>", "storageId": "<id>" }`.
5. `getCase` returns the `deadline` once the answer it's counted from is in, and
   `artifact.letter` once the document is built, if the pack writes one.

The `wageClaim` definition in `packs/packs.testkit.ts` uses all of it.

## Files

A person attaches files in three situations. All use the same two calls:
`uploadUrl`, then `evidence.add` with the storage id the upload returns. The
file goes from the browser straight to storage, so its size isn't bound by a
function's arguments, and `uploadUrl` checks who's asking.

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

Each PDF, image or text file is read once (`case/files.ts`). `read.summary` says
what the file is and the facts it states, and `read.answers` holds the pack's
questions it plainly answers. Those show up in `suggestions` for the person to
accept; nothing a file says is filled in for them. Other kinds of file, and ones
over 10 MB, are kept but not read. A case holds up to 30 files of up to 20 MB
each. `getCase` returns a link to each in `evidenceUrls`.
