# easygov evals

Unit tests say the code does what it says. These say how often the **models** do
what we need, and they run against the real agents, the real web and the real
pipeline. Every case runs several times, because the question is reliability: a
case at 2/3 is a problem one run would have hidden.

## The slices

| Slice      | What goes in                               | What's graded                                                                                         |
| ---------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `intake`   | One message                                | A goal for a clear request; otherwise exactly one question                                            |
| `request`  | A goal                                     | Kind (process, referral, unclear) and jurisdiction; the form number, advisory                         |
| `choose`   | A goal and candidate packs                 | The right pack's number, or 0 for none                                                                |
| `research` | A process and place                        | Sources on the authority's own domain; the facts the case names                                       |
| `draft`    | A process and **frozen** notes             | Finished sentences, no talk of "the notes", every number from the notes, the letter and its questions |
| `prefill`  | What a person said, and a form's questions | Every stated answer is found; nothing unstated is guessed                                             |
| `search`   | A place and search terms                   | The expected pack is found, or nothing is. No model, so one trial                                     |
| `outcome`  | A goal, on a real case                     | Stage 1 comes to a saved pack, a draft, a referral or a question                                      |
| `pipeline` | A fixture pack or a goal                   | The autopilot plays the person to the end: done, delivery, referral, letter                           |

The first five and `prefill` are one model call each, run alone with fixed
inputs. That's why `case/agents.ts` keeps each call in its own function
(`readRequest`, `choosePack`, `research`, `draftProcess`, `prefillAnswers`,
`intakeReply`). The draft's notes are frozen so a grade moves with the prompt,
not with the web.

## Running them

```sh
npx convex run easygov/evals/runner:start '{"note":"what changed"}'
npx convex run easygov/evals/runner:start '{"note":"...","slices":["draft"],"trials":5}'
npx convex run easygov/evals/runner:runs
npx convex run easygov/evals/runner:trials '{"runId":"...","failedOnly":true}'
```

Or use the Evals page in the example app. A full run makes a few hundred model
calls; `research`, `outcome` and `pipeline` are the slow ones.

## Reading a result

- A trial is `passed`, `failed`, or `error` (it crashed: not counted either
  way). `runs` gives each slice and each case as passed/graded.
- Each trial lists its checks by name. One starting with `~` is recorded but
  doesn't decide the trial.
- `detail` says what a check tripped on ("cut off: …", "not in the notes: 75"),
  and `output` is what the step produced.
- The one model-graded check is whether two of a draft's questions ask the same
  thing. Each run first grades a known-good and a known-bad set; if the judge
  gets those wrong, `judgeOk` is false and that check can't be trusted.

## Adding a case

Add it to the slice's list in `cases.ts`. For a draft from a real case, press
"Save as eval case" on the proposal: it keeps the process and the research notes
the draft was written from, and joins the `draft` slice with the general checks
(no letter or question expectations).

When a case fails, read the output before touching the prompt: the first
baseline's draft "failure" was a limit of five questions that was too strict.

## The files

| File         | Job                                                       |
| ------------ | --------------------------------------------------------- |
| `cases.ts`   | The cases, one list per slice                             |
| `grading.ts` | The graders: pure code, tested in `grading.test.ts`       |
| `runner.ts`  | Plans and runs trials, drives real cases, records results |
| `tables.ts`  | Runs, trials, and drafts saved from real cases            |

`runner.ts` is public and checks nothing, like `dev.ts`. Don't ship it.
