# case/

**What is a case, and how does the outside world talk to it?**

A case is one document. It holds the plan, the step it's at, and every fact: the
goal, the selected process pack, the answers, the artifact. Nothing else is the
truth.

| File               | Touches the database? | Job                                                                |
| ------------------ | --------------------- | ------------------------------------------------------------------ |
| `schema.ts`        | no                    | Every case field (`FIELDS`) and every event (`EVENTS`)             |
| `answers.ts`       | no                    | Pure helpers over the answers: `fingerprint`, `missingInputs`      |
| `data.ts`          | yes                   | `writeCase`, the one way to change a case                          |
| `public.ts`        | yes                   | What a client calls: `startCase`, `getCase`, `sendMessage`, `send` |
| `cases.testkit.ts` | (tests)               | Start a case, send it things, the mock model                       |
| `cases.test.ts`    | (tests)               | What `send` refuses, canceling, who may write what                 |

## schema.ts: who owns what

Every field and every event has one owner: the pipeline (`core`) or one stage.

- `FIELDS` is keyed by owner. `core` owns where the case is (`plan`,
  `currentStep`, `visits`, `failure`, `workflowId`, `status`, `seq`); each stage
  owns the facts it produces (`intake` owns `intake`, `collect` owns `answers`,
  and so on).
- `EVENTS` has one row per event a person can send: its `owner`, its `args`, and
  optionally `alsoDuring`.

Two rules follow, and the code enforces both:

- **Only the owner writes a field.** `writeCase` (`data.ts`) is the one way to
  change a case. It takes the owner and refuses a field the owner doesn't own.
  Any stage may _read_ any field.
- **Only the owner handles an event, and only while its step is current.** A
  stage's file has one handler per row it owns. `core` events belong to the
  whole case: `case.cancel` at any time, `step.retry` and `step.cancel` after a
  failure.

`CaseEvent` and `vCaseEvent` are derived from the rows, so there is no second
list to keep in step.

## public.ts: the four things the outside can do

- `startCase` creates the case and its chat thread, then starts the plan.
- `getCase` reads it.
- `sendMessage` saves a chat message. If the current stage chats, it's nudged.
  The client sends a `messageKey` it makes up once per message; the same key
  twice in a row is the same message, and is saved once.
- `send(caseId, event, expectedSeq)` is everything else:
  1. Refuse it if `expectedSeq` isn't the case's `seq`, or the case has ended.
  2. A `core` event goes to the pipeline (`CONTROL_INPUTS` maps it to an input).
  3. Any other event goes to its owner's handler, if the current step's stage
     takes it. `writeCase` writes what the handler returns, as the owner.
  4. The running stage's workflow is nudged to look again.

## No stage clears another's facts

A fact made from another fact records what it was made from, so it is out of
date on its own when that changes:

- `intake.version` goes up each time a goal is set, even to the same words.
- `processPack.goalVersion` is the goal version a selection was made for. A
  selection for an earlier goal counts as none, so a new goal gets a new
  proposal. A `rejected` selection for the current goal makes intake wait for a
  new goal; that's how rejecting, or a question from the selection agent, sends
  the case back to intake.
- `artifact.fingerprint` is the answers the artifact was filled from. When the
  answers change, review sends the case back to collect.
- `approval.fingerprint` is the artifact the person approved.

## The parts that are hard to follow

- **`seq`**: a counter bumped by every write. `send` takes the `expectedSeq` the
  sender last saw, so an event sent from an out-of-date screen is refused.
- **`alsoDuring`**: other stages that take an event while they're current.
  Review takes collect's `answers.set`; collect's handler still does the
  writing, and review then sends the case back.
- **`pendingMessageId`**: the newest chat message no agent has answered.
  `sendMessage` sets it; a stage that chats clears it with `markAnswered`.
- **Why the schema imports nothing generated**: the generated types are built
  from the schema, so they can't also be an input to it.
- **The one cast**: `vCaseEvent` is built from the rows at runtime and cast to
  the derived `CaseEvent` type. `stages/stages.test.ts` checks they match.
