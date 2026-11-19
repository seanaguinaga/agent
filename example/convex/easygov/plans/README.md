# plans/

**Given what just happened, which step runs next?**

A plan is an ordered list of steps stored on the case. Each step says which
stage to run (`type`), optionally with settings (`params`) and a condition
(`when`). Here's an IRS 8822 case after its pack was confirmed:

```ts
[
  { id: "intake", type: "intake" },
  {
    id: "selectProcessPack",
    type: "selectProcessPack",
    params: { backTo: "intake" },
  },
  { id: "collect", type: "collect" },
  { id: "fill", type: "fill" },
  { id: "review", type: "review", params: { backTo: "collect" } },
  { id: "deliver", type: "deliver", params: { channel: "mail" } },
];
```

| File            | Touches the database? | Job                                                    |
| --------------- | --------------------- | ------------------------------------------------------ |
| `schema.ts`     | no                    | The shape of a step and of a `when` condition          |
| `steps.ts`      | no                    | List operations on a plan: insert, find next, validate |
| `decide.ts`     | no                    | Every routing rule, as one pure function               |
| `data.ts`       | yes                   | Carries a decision out; how a stage reports back       |
| `steps.test.ts` | (tests)               | The step helpers, with plain values                    |
| `plans.test.ts` | (tests)               | `decide` with plain values, then whole cases           |

Why split it this way: `steps.ts` and `decide.ts` are plain functions, so you
can test them with ordinary inputs and no database. `data.ts` reads the case,
calls them, and writes the result in a single transaction.

## steps.ts: small helpers

- `bootstrapPlan`: the plan every case starts with,
  `[intake, selectProcessPack]`. Until a pack is confirmed there's nothing else
  to plan.
- `evaluate(condition, answers, flags)`: whether a step's `when` passes.
  `{ input, equals }` checks an answer, `{ flag }` a flag, and `all` / `any`
  combine them. It's data, not a function, because a plan is stored in the
  database.
- `insertAfter(plan, id, steps)`: a new list with `steps` right after `id`.
- `nextRunnableStep(plan, id, answers, flags)`: the first step after `id` whose
  `when` passes. That's how the SSA plan skips the lawyer step.
- `validatePlanStep` / `validateAppend`: why proposed steps can't join the plan
  (a used id, an unknown stage type, bad params, too many steps), or `null` if
  they can.

## decide.ts: where decisions happen

`decide(case, input)` returns a `Decision`. It knows no stage by name.

| Input         | What happened               | Decision                                   |
| ------------- | --------------------------- | ------------------------------------------ |
| `start`       | The case was created        | `run` the first step of the bootstrap plan |
| `stageDone`   | A stage's workflow returned | See below                                  |
| `stageFailed` | A stage's workflow threw    | `park` the case, to wait for a person      |
| `retry`       | A person, after a failure   | `run` the failed step again                |
| `giveUp`      | A person, after a failure   | `end` the case as `stopped`                |
| `cancel`      | A person, at any time       | `end` the case as `canceled`               |

A stage returns one of three results (`vStageResult` in `case/schema.ts`):

- `stop` with a `reason` → `end` the case as `stopped`.
- `back` with `backTo` → `run` that step, e.g. review going back to collect.
- `done`, optionally with steps to `append` → add the steps after this one if
  they're valid, then `run` the next step whose `when` passes. If nothing is
  left, `end` the case as `done`.

Anything that doesn't apply (the case has ended, the callback is stale, there's
no failure to retry) is `ignore`d, with a reason.

## data.ts: carrying it out

- `handle(ctx, caseId, input)` is the one way a case moves: read the case,
  `decide`, `apply`.
- `apply` does the I/O for each decision: start the step's stage workflow and
  point the case at it, or record the failure, or end the case (canceling the
  running workflow on a cancel).
- `stageDone` is the `onComplete` of every stage workflow. It turns the
  workflow's result into a `stageDone` or `stageFailed` input.

## Why there's no workflow per case

A long-lived parent workflow would be replayed from its log every time it
resumes, so changing routing logic would break cases already in progress.
Instead each stage is its own short workflow, and what runs next is decided
fresh, by a mutation, each time one finishes. You can change routing rules,
plans or conditions at any time.

Doing it in one transaction also means a case is never half-updated, for example
a plan changed but `currentStep` still pointing at the old step.

## Adding a routing rule

Add a member to `Input`, a `case` for it in `decide`, and a unit test in
`plans.test.ts`. If nothing existing carries it out, add a member to `Decision`
and a `case` in `apply`. The type checker names a `switch` that misses a member.
Then call `handle` from wherever it happens; for an event a person sends, that's
a `core` row in `EVENTS` and a line in `CONTROL_INPUTS` (`case/public.ts`).

## The parts that are hard to follow

- **`visits`**: how many times each step has started, by step id. A stage
  workflow reports back with the visit it was started for.
- **stale callback**: a `stageDone` or `stageFailed` whose step or visit isn't
  the one the case is on (it was canceled, or the step was retried). Ignored.
- **`failure` and "parked"**: set while the current step's stage has failed. The
  case takes only `step.retry`, `step.cancel` and `case.cancel`. Running a step
  clears it, so a second click on retry finds no failure and is refused.
- **`back`**: "this step finished by sending the case backwards". It names the
  step to go to, not the step that finished.
- **A refused `append`** is noted in `caseEvents` and the case carries on
  without it. If that leaves nothing to run, the case is `stopped`, not `done`.
- **`MAX_PLAN_STEPS = 30`, `MAX_VISITS = 50`**: limits so a plan can't grow or
  loop forever.
- **`startAsync`** in `apply`: a stage that fails at once would otherwise call
  `stageDone` before the case points at it, and look stale.
