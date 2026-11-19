# easygov

A small government-case pipeline. Each case is **one durable workflow** that
reads top to bottom, like `workflows/chaining.ts`:

1. **Agree on what to do.** Intake chats until it knows the goal. The selection
   agent proposes a process pack, and the case waits for the person to confirm
   it. Rejecting it, or a clarifying question, goes back to intake.
2. **Collect, build, review.** The case waits for the pack's answers, builds the
   document, and waits for approval. Editing an answer in review goes around
   again.
3. **Finish.** Open a legal referral or prepare delivery if the pack says so.

Read `case/workflow.ts` first: that is the whole flow. There is no UI and no PDF
filling here.

## The files

| File               | Job                                                                |
| ------------------ | ------------------------------------------------------------------ |
| `case/workflow.ts` | The case's workflow, and how it waits for a person                 |
| `case/data.ts`     | The queries and mutations the workflow calls, and its `onComplete` |
| `case/state.ts`    | Pure: what the case's fields mean, including `waitingFor`          |
| `case/events.ts`   | What a person can send, when it's taken, and what it writes        |
| `case/public.ts`   | What a client calls: `startCase`, `getCase`, `sendMessage`, `send` |
| `case/agents.ts`   | The intake and selection agents                                    |
| `case/schema.ts`   | Every case field and every event                                   |
| `case/answers.ts`  | Pure helpers over the answers                                      |
| `packs/`           | The process pack library: search, save, versions (see its README)  |
| `schema.ts`        | The tables                                                         |

## How it fits together

**The case in the table is the truth.** Every wait in the workflow is a query
over the case ("are all the answers in?"), and a person's event only writes the
case and nudges the workflow to look again. Nothing lives only in the workflow's
history, so:

- `send` and the workflow can't disagree about where the case is. `send` accepts
  an event only while `waitingFor(case)` says the case waits for it, and the
  workflow's waits are worked out from the same fields.
- A retry restarts the workflow from the top. It finds the goal, the pack and
  the answers already there, and carries on from where the case is. That's also
  how to recover a case whose workflow a code change broke.

**The agents save nothing themselves.** Each model call runs as a retried action
and returns a result; the workflow's next mutation decides what to keep. A
retried call can't leave a duplicate in the thread.

**A fact records what it was made from**, so it's out of date on its own:

- `intake.version` goes up each time a goal is set. A pack selection records the
  `goalVersion` it was made for; one for an earlier goal counts as none.
- `artifact.fingerprint` is the answers the document was built from;
  `approval.fingerprint` is the document the person approved.
- `seq` goes up on every write. `send` takes the `expectedSeq` the sender last
  saw, so an event sent from an out-of-date screen is refused.

**Failures park the case.** If the workflow fails, `onComplete` records the
error and the case takes no events until the person sends `step.retry` (run
again from the top) or `step.cancel` (stop). `case.cancel` works at any time.

## Try it from the dashboard

First seed a pack. Run `easygov/packs/data:save` with the `irs8822` definition
from `packs/packs.testkit.ts` (it has no `ownerId`, so it's shared). The agent
proposes it when the goal matches; without a seeded match it drafts a new pack
for you to review instead.

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
   `intake.submit` below instead.)
4. `easygov/case/public:send` with each of these events in turn, as
   `{ "caseId": "<id>", "expectedSeq": <seq>, "event": <event> }`:

   ```json
   { "type": "intake.submit", "goal": "I moved and need to tell the IRS" }
   { "type": "processPack.confirm" }
   { "type": "answers.set", "key": "fullName", "value": "Ada Lovelace" }
   { "type": "answers.set", "key": "oldAddress", "value": "1 Old Road" }
   { "type": "answers.set", "key": "newAddress", "value": "2 New Street" }
   { "type": "review.approve" }
   ```

5. `getCase` now shows `status: "done"` and `delivery.status: "prepared"`.

Seed the `ssaAppeal` definition and state an SSA appeal goal to see a referral:
answering `wantsRepresentation` with `yes` adds a row to `referrals`. The
`caseEvents` table is the case's history.
