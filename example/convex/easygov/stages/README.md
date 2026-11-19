# stages/

**What happens at one step?**

A stage is a short workflow that waits on facts on the case and returns `done`,
`back` or `stop`. It never decides what runs next; `plans/` does.

| File                 | Touches the database? | Job                                                  |
| -------------------- | --------------------- | ---------------------------------------------------- |
| `shared.ts`          | no                    | What every stage is made of: `waitFor`, `nudgeStage` |
| `registry.ts`        | no                    | The list of stages, and which handler takes an event |
| `stages.test.ts`     | (tests)               | Fails when a stage is half-added                     |
| `<name>/workflow.ts` | through `data.ts`     | The stage's workflow: `params`, `chats`, `run`       |
| `<name>/events.ts`   | returns what to write | Handlers for the events the stage owns               |
| `<name>/data.ts`     | yes                   | The queries and mutations the workflow calls         |
| `<name>/agent.ts`    | no                    | The agent, and the action that calls the model       |

Every stage has a `workflow.ts`. It has the other three only if it needs them:
`fill` has no events and no agent, so it's `workflow.ts` and `data.ts`.

## The stages

| Stage               | What it does                                                       |
| ------------------- | ------------------------------------------------------------------ |
| `intake`            | Chats with the person until it knows their goal (an agent)         |
| `selectProcessPack` | Proposes a pack for the goal, then waits for the person (an agent) |
| `collect`           | Waits until every answer the pack needs is in                      |
| `fill`              | Writes the artifact from the answers. A stand-in for PDF filling   |
| `review`            | Waits for approval, or goes back when an answer changes            |
| `deliver`           | Marks the approved artifact as ready to send. Nothing is sent      |
| `legalReferral`     | Opens a referral row for someone else to pick up                   |

The two agent stages run the model as a workflow step (`step.runAction` with
`retry`), save nothing themselves, and hand a typed result to a mutation that
decides what to keep. So a retried call can't leave a duplicate.

## What each stage file exports

- `workflow.ts`:
  - `params`: a zod schema that narrows the step's flat string params.
  - `chats`: `true` if the stage answers chat messages, so `sendMessage` nudges
    it.
  - `run`: the workflow,
    `workflow.define({ args: stageArgs, returns: vStageResult, handler })`. Its
    first line parses its own params: `params.parse(args.params ?? {})`.
- `events.ts`: `events`, typed `StageEvents<"<name>">`, with one handler per row
  of `EVENTS` the stage owns. A handler returns the stage's own fields to write.
- `data.ts`: `check`, the query the workflow waits on (a result, or `null` to
  keep waiting), and the mutations that keep what the workflow produced. A
  mutation writes with `writeCase(ctx, "<name>", caseId, patch)`.
- `agent.ts`: the `Agent`, and an action that calls the model and saves nothing.
  A mutation in `data.ts` (`record`) decides what to keep.

## How a stage waits for a person

1. The workflow calls `waitFor(step, check)`, where `check` is the query in
   `data.ts` that reads the case and returns a result, or `null` to keep
   waiting.
2. A person's event is written to the case by `send`.
3. `nudgeStage` sends the workflow the `"stage"` event, which carries nothing:
   it only means "look again".
4. `waitFor` runs `check` again.

## Adding a stage

1. In `case/schema.ts`, add the stage to `FIELDS` (the case fields it owns, or
   `{}`) and spread them into `caseFields`. Add a row to `EVENTS` for each event
   it owns. To take an event another stage owns, add the stage to that row's
   `alsoDuring`.
2. Write `stages/<name>/workflow.ts`, and `events.ts`, `data.ts` and `agent.ts`
   as the stage needs them.
3. Write `<name>.test.ts` next to it.
4. Add `<name>: stage("<name>", <name>, <name>Events)` to `STAGES` in
   `registry.ts`. Pass `{}` for a stage that owns no events.

You don't touch `case/public.ts` or `plans/`. If you miss a step, the type
checker or `stages.test.ts` names it: a folder that isn't registered, a stage
missing from a list, a missing export, a file that isn't named for a job, an
event with no handler, a field with two owners, or a handler that writes a field
its stage doesn't own.

## The parts that are hard to follow

- **The `"stage"` event has no payload**, because the truth is in the tables.
  Nothing is lost if the stage hasn't begun waiting yet: the event is buffered,
  and a stage reads the case when it starts.
- **`workflowId`** on the case is the stage workflow running now: what
  `nudgeStage` nudges. With none (the step failed, or the case ended) nothing is
  sent.
- **Stage actions must be idempotent**: they're retried by default.
- **Stage files don't import the registry, or anything in `plans/`**, which
  imports the registry. Each stage owns its params schema, so it has no need to.
- **The registry names each workflow with `makeFunctionReference`**, not through
  the generated `internal` API, whose type is made of the stage files. Each
  `run` handler's return type is written out for the same reason.
