# easygov

A small government-case pipeline. **Stage types are code** (one folder per type,
in `stages/`). **Plans are data** (a list of steps stored on the case). One thin
parent workflow per case runs whatever plan the case has pinned, and one
mutation, `advance`, makes every routing decision.

Two stages use agents, kept very simple: **intake** chats with the person until
it knows their goal, and **route** proposes which known process fits. Both run
as workflow steps (`step.runAction` with `retry`), save nothing themselves, and
hand a typed result to a mutation that decides what to keep. The other stages
are stubs that wait for a person. There is no UI and no PDF filling here.

Packs are hard-coded in `packs/` for now. Only `listPacks` and `getPack` read
them, so moving packs into a table changes one file.

## Read in this order

1. `cases.ts`: what the outside world can do: `startCase`, `getCase`,
   `sendMessage`, `send`.
2. `pipeline.ts`: how a case runs. The parent loop is at the top; `advance` and
   its four parts (`amendPlan`, `recordStep`, `chooseNext`, `enterStep`) decide
   what's next.
3. `stage.ts`: what a stage is: `defineStage`, `waitFor`, and the shape of the
   events a stage accepts.
4. `stages/route/route.ts`: one whole stage, top to bottom: its agent, its
   events, its workflow, and the queries and mutation the workflow calls.
5. `packs/irs8822.ts`: one process: its inputs and its plan.

`plan.ts` (pure plan operations) and `stages/stages.registry.ts` (the list of
stage types) are short lookups from there.

## The flow

1. `startCase` creates a case and starts the parent workflow, `govCase`
   (`pipeline.ts`).
2. `pin` writes the bootstrap plan, `[intake, route]`, and returns `intake`.
3. The parent runs the step's stage workflow, then calls `advance` with the
   result (`done`, `back` or `stop`). `advance` returns the next step, or null
   when the case is over.
4. When `route` finishes, `advance` splices the confirmed pack's plan in after
   it. From then on the case follows that plan, skipping steps whose `when`
   doesn't pass.
5. A stage that waits reads a fact from the `cases` table. `send` looks up the
   active stage's handler for the event, writes the fact the handler returns,
   then sends the stage a `"stage"` event, which only means "look again".
6. If a stage throws, its step becomes `failed` and the parent waits for
   `step.retry` or `step.cancel`.

A case ends as `done` (the plan ran out), `stopped`, `failed` or `canceled`. All
but `done` have an `endReason`.

For example, "confirm a route" is three files: `send` in `cases.ts` finds the
`route.confirm` handler, which lives in `stages/route/route.ts` next to the
workflow that's waiting for it; the workflow returns `done`, and `advance` in
`pipeline.ts` splices in the pack's plan.

## Where things are

Files are grouped by what they're about, not by what kind of code they hold. A
stage's agent, events, workflow, queries and tests are all in its folder.

| Path                        | Job                                                         |
| --------------------------- | ----------------------------------------------------------- |
| `cases.ts`                  | The public API, and who may touch a case                    |
| `pipeline.ts`               | The parent workflow and every routing decision              |
| `plan.ts`                   | Pure plan operations: insert, next step, `when`, validation |
| `stage.ts`                  | What a stage is: `defineStage`, `waitFor`, `StageEvents`    |
| `stages/<name>/<name>.ts`   | One stage type, whole                                       |
| `stages/stages.registry.ts` | The list of stage types: params, workflow, events           |
| `packs/`                    | The processes: required inputs and a plan for each          |
| `schema.ts`                 | The `cases`, `caseEvents` and `referrals` tables            |
| `validators.ts`             | Shapes shared by plans, stages and the API                  |
| `answers.ts`                | Pure helpers over a case's answers                          |
| `cases.testkit.ts`          | Test helpers: start a case, send it things, the mock model  |

Tests sit next to what they test: `plan.test.ts`, `pipeline.test.ts`,
`cases.test.ts`, `stages/route/route.test.ts`, `packs/irs8822.test.ts`. A
stage's evals would go in its folder too.

## Adding things

**A stage type.** Create `stages/<name>/<name>.ts`. Export `<name>Params` (a zod
schema), `run` (the workflow, from `defineStage`), and `<name>Events` if a
person can send it anything. Then add one entry to `STAGES` in
`stages/stages.registry.ts`. `send` only accepts an event when the active stage
lists it. A brand-new event type also needs its shape added to `vCaseEvent` in
`validators.ts`.

**A process.** Add `packs/<key>.ts` and list it in `PACKS` in `packs/index.ts`.

Two rules keep the types working:

- `stages.registry.ts` has an extra dot in its name so Convex codegen skips it.
  It refers to the generated `internal` API, so it can't be part of that API.
- Stage files don't import the registry. Each stage owns its params schema, so
  it has no need to.

## Try it from the dashboard

Run each function from the dashboard's Functions page. Every `send` needs the
case's current `seq`, which changes after each step, so read it with `getCase`
first.

1. `easygov/cases:startCase` with `{}`. Copy the returned id.
2. `easygov/cases:getCase` with `{ "caseId": "<id>" }`. The `stage` is `intake`.
3. Chat with intake: `easygov/cases:sendMessage` with
   `{ "caseId": "<id>", "text": "I moved and need to tell the IRS" }`. Its
   replies land in the case's thread. Once it knows the goal, route proposes a
   process and the case's `route.status` is `proposed`. (Or skip the agents:
   send `intake.submit` below instead.)
4. `easygov/cases:send` with each of these events in turn, as
   `{ "caseId": "<id>", "expectedSeq": <seq>, "event": <event> }`:

   ```json
   { "type": "intake.submit", "goal": "I moved house" }
   { "type": "route.confirm", "processKey": "irs8822" }
   { "type": "answers.set", "key": "fullName", "value": "Ada Lovelace" }
   { "type": "answers.set", "key": "oldAddress", "value": "1 Old Road" }
   { "type": "answers.set", "key": "newAddress", "value": "2 New Street" }
   { "type": "review.approve" }
   ```

5. `getCase` now shows `status: "done"` and `delivery.status: "prepared"`.

Use `"processKey": "ssaAppeal"` to see a conditional step: answering
`wantsRepresentation` with `yes` adds a row to `referrals`. The `caseEvents`
table logs each routing decision.
