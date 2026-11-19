# easygov

A small government-case pipeline. **Stage types are code** (one folder per type,
in `stages/`). **Plans are data** (a list of steps stored on the case). Each
stage is a workflow; when one finishes, the next is started. There is no
long-lived workflow per case. One pure function, `decide`, makes every routing
decision.

Two stages use agents, kept very simple: **intake** chats with the person until
it knows their goal, and **selectProcessPack** proposes which saved pack fits.
Both run as workflow steps (`step.runAction` with `retry`), save nothing
themselves, and hand a typed result to a mutation that decides what to keep. The
other stages are stubs that wait for a person. There is no UI and no PDF filling
here.

Every process pack is a row in `processPacks`; none are defined in code.

## The folders

Each folder answers one question, and has a README that explains its files. The
folder names the concern; the file names the job.

| Folder                        | The question it answers                              |
| ----------------------------- | ---------------------------------------------------- |
| [`case/`](case/README.md)     | What is a case, and how does the outside talk to it? |
| [`plans/`](plans/README.md)   | Given what just happened, which step runs next?      |
| [`stages/`](stages/README.md) | What happens at one step?                            |
| [`packs/`](packs/README.md)   | Which saved process pack fits this request?          |

`schema.ts` at the top lists the tables.

## How files are named

A file is named for its job, and the same name means the same job in every
folder. To find something, pick the folder for the concern, then the file for
the job.

| File           | Job                                                          | Touches the database? |
| -------------- | ------------------------------------------------------------ | --------------------- |
| `schema.ts`    | Shapes: validators and the types made from them              | no                    |
| `data.ts`      | Reads and writes: queries, mutations, and their helpers      | yes                   |
| `public.ts`    | Functions a client calls                                     | yes                   |
| `workflow.ts`  | A stage's workflow: `params`, `chats`, `run`                 | through `data.ts`     |
| `events.ts`    | A stage's handlers for what a person sends                   | returns what to write |
| `agent.ts`     | A stage's agent and the action that calls the model          | no                    |
| `*.test.ts`    | Tests, next to what they test                                |                       |
| `*.testkit.ts` | Test helpers. The extra dot keeps Convex from deploying them |                       |

Anything else is pure logic named for what it holds: `plans/steps.ts`,
`plans/decide.ts`, `case/answers.ts`, `stages/registry.ts`.

A Convex function's path is its name, so functions are short verbs:
`case/public:send`, `plans/data:stageDone`, `packs/data:save`,
`stages/intake/agent:turn`. In every stage, `workflow:run` is the workflow and
`data:check` is the query it waits on.

## Mental model

Five ideas cover all of it:

1. **A case is one document.** It holds the plan, the step it's at
   (`currentStep`), and the facts (the goal, the process pack, the answers, …).
   Nothing else is the truth. `caseEvents` is the history: how each step ended.
   `case/schema.ts` lists every field and every event, each under its one owner:
   the pipeline (`core`) or a stage.
2. **A plan is a list of steps pinned to the case.** A step names a stage type
   and its params. A stage can add steps after itself by returning `append`;
   that's how `selectProcessPack` adds the confirmed pack's steps.
3. **A stage is a workflow that waits on facts** and returns `done` (with any
   steps to `append`), `back` (with the `backTo` step) or `stop` (with a
   `reason`). It never decides what runs next. Its folder has a `workflow.ts`,
   and an `events.ts`, `data.ts` and `agent.ts` if it needs them.
4. **Events write facts, and only a field's owner writes it.** `send` runs the
   handler of the stage that owns the event and writes what it returns.
   `writeCase` (`case/data.ts`) is the one way to change a case: it takes the
   owner, refuses a field the owner doesn't own, and bumps `seq`. Any stage may
   read any field. The `"stage"` event that follows carries nothing: it only
   means "look again". It goes to `workflowId`, the stage workflow the case is
   running now.
5. **A case moves only through `handle(caseId, input)`** (`plans/data.ts`). An
   `Input` is something that happened: `start`, `stageDone`, `stageFailed`,
   `retry`, `giveUp`, `cancel`. `decide(case, input)` is pure and returns a
   `Decision`: `run` a step, `park` the case after a failure, `end` it, or
   `ignore` the input. `apply` carries the decision out. `decide` knows no stage
   by name: it adds any appended steps, then picks the next step whose `when`
   passes, or the `backTo` step, or ends the case.

Every stage workflow is started with `stageDone` as its `onComplete`, which
turns the workflow's result into a `stageDone` or `stageFailed` input. The
callback carries the step id and the visit it was started for; if the case has
moved on (it was canceled, or the step was retried), `decide` ignores it.

One click, from the outside in:

```text
cases.send(event, expectedSeq)
  → the owning stage's handler returns its fields to write
  → writeCase writes them and bumps seq
  → nudgeStage sends "stage" to the running workflow
  → the stage's waitFor re-runs its check query, which now returns a result
  → the workflow returns; its onComplete is plans/data:stageDone
  → handle → decide → apply
  → the next step's workflow starts
```

For `processPack.confirm`, the handler writes `case.processPack` with status
`confirmed`, selectProcessPack's check returns
`{ outcome: "done", append: <the pack's plan> }`, and `decide` starts `collect`
with the extended plan.

## The flow

1. `startCase` creates a case and calls `handle(start)`: the bootstrap plan,
   `[intake, selectProcessPack]`, is written and `intake`'s workflow is started.
2. When a stage's workflow returns (`done`, `back` or `stop`), its `onComplete`,
   `stageDone`, calls `handle(stageDone)`. `decide` picks the next step and
   `apply` starts its workflow, or ends the case.
3. When `selectProcessPack` finishes, its result appends the confirmed pack's
   plan, and `decide` adds those steps after it. From then on the case follows
   that plan, skipping steps whose `when` doesn't pass.
4. A stage that waits reads a fact from the `cases` table. `send` looks up the
   handler for the event, if the active stage takes it, writes the fact the
   handler returns, then sends the stage a `"stage"` event, which only means
   "look again".
5. If a stage throws, `handle(stageFailed)` parks the case: `failure` is set,
   and it waits for `step.retry` (run the step again) or `step.cancel` (stop the
   case). A result `decide` can't route (a `back` to a missing step) parks the
   case the same way.
6. `case.cancel` ends the case and cancels the stage workflow it was running.

A case ends as `done` (the plan ran out), `stopped` or `canceled`. All but
`done` have an `endReason`.

## Read in this order

1. `case/schema.ts`: what a case holds and which events it takes.
2. `case/public.ts`: what the outside world can do.
3. `plans/decide.ts`: every routing rule, then `plans/data.ts`, which carries a
   decision out.
4. `stages/shared.ts`: what every stage shares.
5. `stages/collect/`: the smallest stage that waits on a person. Then
   `stages/selectProcessPack/`, the largest.
6. `packs/data.ts`: where packs are stored, searched and saved.

## Try it from the dashboard

First seed a pack. Run `easygov/packs/data:save` with the `irs8822` definition
from `packs/packs.testkit.ts` (it has no `ownerId`, so it's shared). The agent
proposes it when the goal matches; without a seeded match it drafts a new pack
for you to review instead.

Run each function from the dashboard's Functions page. Every `send` needs the
case's current `seq`, which changes after each step, so read it with `getCase`
first.

1. `easygov/case/public:startCase` with `{}`. Copy the returned id.
2. `easygov/case/public:getCase` with `{ "caseId": "<id>" }`. The `currentStep`
   is `intake`.
3. Chat with intake: `easygov/case/public:sendMessage` with
   `{ "caseId": "<id>", "text": "I moved and need to tell the IRS", "messageKey": "m1" }`
   (use a new `messageKey` for each message). Its replies land in the case's
   thread. Once it knows the goal, `selectProcessPack` proposes a pack and
   `processPack.status` is `proposed`. (Or skip the agents: send `intake.submit`
   below instead.)
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

`processPack.confirm` confirms whatever was proposed; read
`processPack.definition` (a saved pack) or `processPack.draft` first. Seed the
`ssaAppeal` definition and state an SSA appeal goal to see a conditional step:
answering `wantsRepresentation` with `yes` adds a row to `referrals`. The
`caseEvents` table logs each step that started, how it ended, and every change
to the plan.
