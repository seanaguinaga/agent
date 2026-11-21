// Runs the easygov evals and shows how each slice, stage and the whole
// pipeline did: pass rates over several trials, not one lucky run.
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { SLICES, type Slice } from "../../convex/easygov/evals/tables";
import { useAct } from "./session";
import { Chip, Page, Refusal } from "./Workbench";

const runner = api.easygov.evals.runner;

const ABOUT: Record<Slice, string> = {
  intake: "One message in; a goal, or one question back. Model.",
  request: "A goal in; its kind, place and forms out. Model.",
  choose: "A goal and candidate packs; the right one, or none. Model.",
  research: "A process in; notes from the authority's own site. Live web.",
  forms: "A goal in; the official forms it needs, each fetched. Live web.",
  draft: "Frozen notes in; a checklist and letter out. Model + judge.",
  suggest:
    "What a person said and a form's questions; only stated answers. Model.",
  tailor: "A checklist and a situation; only the steps that apply. Model.",
  address: "An address as one line; its parts, with nothing made up. Model.",
  mapping: "A form's places and their printed words; what goes in each. Model.",
  search: "The pack library's search. No model, one trial.",
  outcome: "Stage 1 on a real case: pack, draft, referral or question.",
  pipeline: "A whole case, played by the autopilot to the end.",
};

function rate({ passed, graded }: { passed: number; graded: number }) {
  return graded ? `${Math.round((100 * passed) / graded)}%` : "–";
}

function Start() {
  const start = useMutation(runner.start);
  const [note, setNote] = useState("");
  const [trials, setTrials] = useState(3);
  const [picked, setPicked] = useState<Slice[]>([...SLICES]);
  const act = useAct();
  return (
    <form
      className="demo-panel"
      onSubmit={(event) => {
        event.preventDefault();
        void act.run(() => start({ note, trials, slices: picked }));
      }}
    >
      <h2 className="font-semibold">Start a run</h2>
      <div className="grid gap-2 sm:grid-cols-2">
        {SLICES.map((slice) => (
          <label key={slice} className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={picked.includes(slice)}
              onChange={(event) =>
                setPicked(
                  event.target.checked
                    ? [...picked, slice]
                    : picked.filter((other) => other !== slice),
                )
              }
            />
            <span>
              <strong>{slice}</strong>{" "}
              <span className="text-gray-600">{ABOUT[slice]}</span>
            </span>
          </label>
        ))}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="grow">
          <label className="demo-label" htmlFor="eval-note">
            What changed since the last run
          </label>
          <input
            id="eval-note"
            className="input-field"
            placeholder="e.g. draft: never mention the notes"
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
        <div>
          <label className="demo-label" htmlFor="eval-trials">
            Trials per case
          </label>
          <input
            id="eval-trials"
            type="number"
            min={1}
            max={10}
            className="input-field w-24"
            value={trials}
            onChange={(event) => setTrials(Number(event.target.value))}
          />
        </div>
        <button
          className="demo-button"
          disabled={act.pending || !note.trim() || !picked.length}
        >
          Run
        </button>
      </div>
      <p className="text-sm text-gray-600">
        Every slice but the search calls the model, and research reads the live
        web: a full run makes a few hundred calls.
      </p>
      <Refusal error={act.error} />
    </form>
  );
}

function Trials({ runId }: { runId: Id<"easygovEvalRuns"> }) {
  const [failedOnly, setFailedOnly] = useState(true);
  const trials = useQuery(runner.trials, { runId, failedOnly });
  const [open, setOpen] = useState<string>();
  return (
    <div className="space-y-2 border-t pt-3">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={failedOnly}
          onChange={(event) => setFailedOnly(event.target.checked)}
        />
        Only failed and crashed trials
      </label>
      {trials?.length === 0 && (
        <p className="text-sm text-gray-500">
          {failedOnly ? "Nothing failed." : "No trials."}
        </p>
      )}
      {trials?.map((trial) => {
        const key = `${trial.slice}/${trial.caseId}/${trial.trial}`;
        const errored = trial.status === "error";
        const graded = trial.status === "passed" || trial.status === "failed";
        const why = errored ? trial.error : graded ? trial.detail : undefined;
        return (
          <div key={key} className="rounded-lg border p-2 text-sm">
            <button
              className="flex w-full flex-wrap items-center gap-2 text-left"
              onClick={() => setOpen(open === key ? undefined : key)}
            >
              <Chip
                tone={
                  trial.status === "passed"
                    ? "green"
                    : trial.status === "pending"
                      ? "blue"
                      : trial.status === "error"
                        ? "amber"
                        : "red"
                }
              >
                {trial.status}
              </Chip>
              <strong>{trial.slice}</strong>
              <span>
                {trial.caseId} #{trial.trial}
              </span>
              {Object.entries(graded ? trial.checks : {}).map(([name, ok]) => (
                <span
                  key={name}
                  className={ok ? "text-green-700" : "text-red-700"}
                >
                  {ok ? "✓" : "✗"} {name}
                </span>
              ))}
              {trial.status !== "pending" && (
                <span className="ml-auto text-gray-500">
                  {(trial.ms / 1000).toFixed(1)}s
                </span>
              )}
            </button>
            {why && <p className="mt-1 text-gray-700">{why}</p>}
            {open === key && graded && trial.output && (
              <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-gray-50 p-2 text-xs">
                {trial.output}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Runs() {
  const runs = useQuery(runner.runs, {});
  const [open, setOpen] = useState<Id<"easygovEvalRuns">>();
  return (
    <div className="demo-panel">
      <h2 className="font-semibold">Runs</h2>
      {runs?.length === 0 && <p className="text-sm text-gray-500">None yet.</p>}
      {runs?.map((run) => (
        <div key={run.runId} className="space-y-2 rounded-lg border p-3">
          <button
            className="w-full space-y-2 text-left"
            onClick={() => setOpen(open === run.runId ? undefined : run.runId)}
          >
            <p className="flex flex-wrap items-center gap-2 text-sm">
              <Chip tone={run.status === "done" ? "green" : "blue"}>
                {run.status === "done"
                  ? "done"
                  : `${run.finishedTrials}/${run.totalTrials}`}
              </Chip>
              <strong>{run.note}</strong>
              <span className="text-gray-500">
                {new Date(run.startedAt).toLocaleString()} · {run.models}
              </span>
              {run.judgeOk === false && (
                <Chip tone="red">judge failed its own check</Chip>
              )}
            </p>
            <p className="flex flex-wrap gap-2 text-sm">
              {SLICES.filter((slice) => run.slices[slice]).map((slice) => {
                const tally = run.slices[slice];
                const all = tally.graded > 0 && tally.passed === tally.graded;
                return (
                  <Chip
                    key={slice}
                    tone={
                      all && !tally.errors
                        ? "green"
                        : tally.graded
                          ? "red"
                          : "amber"
                    }
                  >
                    {slice} {rate(tally)} ({tally.passed}/{tally.graded}
                    {tally.errors ? `, ${tally.errors} crashed` : ""})
                  </Chip>
                );
              })}
            </p>
          </button>
          {open === run.runId && (
            <>
              <ul className="grid gap-x-6 text-sm sm:grid-cols-2">
                {Object.entries(run.cases).map(([name, score]) => {
                  const [passed, graded] = score.split(/[/ ]/).map(Number);
                  return (
                    <li key={name} className="flex justify-between gap-3">
                      <span>{name}</span>
                      <span
                        className={
                          passed === graded && !score.includes("crashed")
                            ? "text-green-700"
                            : "font-medium text-red-700"
                        }
                      >
                        {score}
                      </span>
                    </li>
                  );
                })}
              </ul>
              <Trials runId={run.runId} />
            </>
          )}
        </div>
      ))}
    </div>
  );
}

function Saved() {
  const saved = useQuery(runner.savedCases, {});
  const remove = useMutation(runner.removeSavedCase);
  return (
    <div className="demo-panel">
      <h2 className="font-semibold">Draft cases saved from real cases</h2>
      <p className="text-sm text-gray-600">
        On a drafted proposal, "Save as eval case" keeps the process and the
        research it was written from. Each one joins the draft slice.
      </p>
      {saved?.length === 0 && (
        <p className="text-sm text-gray-500">None yet.</p>
      )}
      {saved?.map((row) => (
        <p key={row.id} className="flex flex-wrap items-center gap-2 text-sm">
          <span>{row.name}</span>
          <span className="text-gray-500">{row.jurisdiction}</span>
          {!row.hasNotes && <Chip tone="amber">no research notes</Chip>}
          <button
            className="ml-auto text-red-700 underline"
            onClick={() => void remove({ id: row.id })}
          >
            Remove
          </button>
        </p>
      ))}
    </div>
  );
}

export default function Evals() {
  return (
    <Page
      title="easygov evals"
      description="Each model call on its own, stage 1 end to end, and whole cases, run several times each. A case at 2/3 is a reliability problem one run would have hidden."
    >
      <Start />
      <Runs />
      <Saved />
    </Page>
  );
}
