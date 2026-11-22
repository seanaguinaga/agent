// Where a case is, as a timeline: every phase the case goes through, who
// acts in it, and what was recorded while it was there. The phase the
// workflow is working in says so while it works, like a model's reasoning
// does as it streams; open any phase to see what came of it.
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { CaseView } from "../../convex/easygov/autopilot";
import type { HistoryKind, Phase } from "../../convex/easygov/case/schema";
import type { ReadStatus } from "../../convex/easygov/forms/schema";

type Step = {
  phase: Phase;
  label: string;
  /** Who acts: the person, or the workflow on its own. */
  who: "person" | "workflow";
  /** What's going on while the case is here. */
  doing: string;
  /** The history recorded while the case is in this phase. */
  kinds: HistoryKind[];
};

/** The phases a running case goes through, in order. */
const TRACK: Step[] = [
  {
    phase: "intake",
    label: "Goal",
    who: "person",
    doing: "Waiting for the person to say what they want done",
    kinds: ["case.started", "case.claimed", "goal.set"],
  },
  {
    phase: "proposing",
    label: "Find a process",
    who: "workflow",
    doing: "Looking for a process that fits the goal",
    kinds: ["pack.proposed", "pack.clarification"],
  },
  {
    phase: "pack",
    label: "Accept the process",
    who: "person",
    doing: "Waiting for the person to accept the process, or reject it",
    kinds: ["pack.rejected"],
  },
  {
    phase: "suggesting",
    label: "Read the conversation",
    who: "workflow",
    doing: "Reading what the person already said for answers",
    kinds: ["answers.suggested"],
  },
  {
    phase: "answers",
    label: "Answers and files",
    who: "person",
    doing: "Waiting for the person's answers and files",
    kinds: ["answer.changed"],
  },
  {
    phase: "filling",
    label: "Build the document",
    who: "workflow",
    doing: "Building the document from the answers",
    kinds: ["artifact.filled"],
  },
  {
    phase: "review",
    label: "Review",
    who: "person",
    doing: "Waiting for the person to accept the document",
    kinds: ["artifact.reassessed"],
  },
  {
    phase: "consent",
    label: "Share with a lawyer",
    who: "person",
    doing: "Waiting for the person to share the case with a lawyer, or not",
    kinds: ["referral.shared", "referral.accepted", "referral.withdrawn"],
  },
  {
    phase: "finishing",
    label: "Finish",
    who: "workflow",
    doing: "Preparing delivery and ending the case",
    kinds: [],
  },
];

/** How the case ended or stalled, for the phases that aren't on the track. */
const ENDS: Partial<Record<Phase, { label: string; tone: string }>> = {
  failed: { label: "The workflow failed", tone: "text-red-700" },
  done: { label: "Done", tone: "text-green-700" },
  stopped: { label: "Stopped", tone: "text-red-700" },
  canceled: { label: "Canceled", tone: "text-red-700" },
};
const END_KINDS: HistoryKind[] = [
  "case.failed",
  "case.retried",
  "case.done",
  "case.stopped",
  "case.canceled",
];

type Entry = { at: number; kind: HistoryKind; detail?: string };

/** One line of what the case is doing now: for a heading or a list row. */
export function phaseLine(
  c: Pick<CaseView, "phase" | "endReason"> & { run?: CaseView["run"] },
): string {
  const step = TRACK.find((s) => s.phase === c.phase);
  // Held back by a rate limit: say when its turn comes.
  if (step && c.run?.state === "delayed") {
    const at = new Date(c.run.until).toLocaleTimeString();
    return `${step.doing} (waiting its turn until ${at})`;
  }
  if (step) return step.doing;
  return c.endReason ?? ENDS[c.phase]?.label ?? c.phase;
}

/** What the workflow is doing with a scanned form, while it works. */
export function readingLine(form: {
  code: string;
  status: ReadStatus;
}): string {
  const copy = `a scanned copy of ${form.code}`;
  switch (form.status) {
    case "reading":
      return `Reading ${copy}`;
    case "retrying":
      return `Reading ${copy}: retrying`;
    case "backup":
      return `Reading ${copy} with the backup reader`;
    case "read":
      return `Read ${copy}`;
    case "readByBackup":
      return `Read ${copy} with the backup reader`;
    case "unread":
      return `Couldn’t read ${copy}; it may need completing by hand`;
  }
}

type State = "past" | "skipped" | "now" | "working" | "ahead";

function Mark({ state }: { state: State }) {
  if (state === "skipped") return <span className="text-gray-400">–</span>;
  if (state === "past") {
    return <span className="text-green-600">✓</span>;
  }
  if (state === "ahead") return <span className="text-gray-300">○</span>;
  return (
    <span
      className={`inline-block h-2.5 w-2.5 rounded-full bg-blue-500 ${state === "working" ? "animate-pulse" : ""}`}
    />
  );
}

function Events({ events }: { events: Entry[] }) {
  return (
    <ol className="space-y-1">
      {events.map((event, i) => (
        <li key={i} className="flex gap-3">
          <span className="w-20 shrink-0 text-gray-400">
            {new Date(event.at).toLocaleTimeString()}
          </span>
          <code className="shrink-0">{event.kind}</code>
          <span className="text-gray-600">{event.detail}</span>
        </li>
      ))}
    </ol>
  );
}

export function Phases({ c, guestKey }: { c: CaseView; guestKey?: string }) {
  const history = useQuery(api.easygov.case.public.listHistory, {
    caseId: c._id,
    guestKey,
  });
  const at = TRACK.findIndex((step) => step.phase === c.phase);
  const end = ENDS[c.phase];
  const eventsOf = (kinds: HistoryKind[]) =>
    (history ?? []).filter((event) => kinds.includes(event.kind));
  const ended = eventsOf(END_KINDS);
  return (
    <ol className="space-y-1" aria-label="Phases of the case">
      {TRACK.map((step, i) => {
        const events = eventsOf(step.kinds);
        // Off the track (ended or failed), a phase counts as passed only if
        // something was recorded in it: where the case stopped isn't kept.
        const behind =
          at === -1 ? events.length > 0 || c.phase === "done" : i < at;
        // Passed with nothing to show for it: a case started on a pack
        // never looked for one, so nobody accepted one either.
        const quiet = (quietStep: Step) =>
          quietStep.kinds.length > 0 && eventsOf(quietStep.kinds).length === 0;
        const skipped =
          behind && (step.phase === "pack" ? quiet(TRACK[i - 1]) : quiet(step));
        const past = behind && !skipped;
        const now = i === at;
        const state = skipped
          ? "skipped"
          : past
            ? "past"
            : now
              ? step.who === "workflow"
                ? "working"
                : "now"
              : "ahead";
        return (
          <li key={step.phase}>
            <details
              className="rounded-lg border px-3 py-2 text-sm open:bg-gray-50"
              // The phase the case is in starts open, like live reasoning.
              open={now || undefined}
              data-phase={step.phase}
              data-state={state}
            >
              <summary className="flex cursor-pointer items-center gap-2">
                <span className="flex w-4 justify-center">
                  <Mark state={state} />
                </span>
                <span
                  className={
                    now
                      ? "font-semibold"
                      : past
                        ? "text-gray-700"
                        : "text-gray-400"
                  }
                >
                  {step.label}
                </span>
                <span className="text-xs text-gray-400">
                  {step.who === "person" ? "the person" : "the workflow"}
                </span>
                {now && (
                  <span
                    className={`ml-auto text-xs text-blue-700 ${state === "working" ? "animate-pulse" : ""}`}
                    role="status"
                  >
                    {step.doing}
                    {state === "working" && "…"}
                  </span>
                )}
              </summary>
              <div className="mt-2 space-y-1 pl-6">
                {!now && <p className="text-gray-500">{step.doing}.</p>}
                {now &&
                  c.run?.state === "running" &&
                  c.run.reading?.map((form) => (
                    <p key={form.code} className="text-blue-700" role="status">
                      {readingLine(form)}
                    </p>
                  ))}
                {events.length > 0 ? (
                  <Events events={events} />
                ) : (
                  <p className="text-gray-400">Nothing recorded here yet.</p>
                )}
              </div>
            </details>
          </li>
        );
      })}
      {end && (
        <li>
          <details
            className="rounded-lg border px-3 py-2 text-sm open:bg-gray-50"
            open
            data-phase={c.phase}
            data-state="now"
          >
            <summary className="flex cursor-pointer items-center gap-2">
              <span className={`font-semibold ${end.tone}`}>{end.label}</span>
              <span className="text-gray-600">
                {c.run?.state === "failed" ? c.run.error : c.endReason}
              </span>
            </summary>
            <div className="mt-2 pl-6">
              <Events events={ended} />
            </div>
          </details>
        </li>
      )}
    </ol>
  );
}
