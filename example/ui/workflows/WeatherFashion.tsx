import {
  optimisticallySendMessage,
  useSmoothText,
  useUIMessages,
  type UIMessage,
} from "@convex-dev/agent/react";
import {
  getToolName,
  type DynamicToolUIPart,
  type ToolUIPart,
} from "ai";
import { usePaginatedQuery } from "convex-helpers/react";
import { useMutation, useQuery } from "convex/react";
import {
  createContext,
  useContext,
  useMemo,
  useState,
} from "react";
import ReactMarkdown from "react-markdown";
import { api } from "../../convex/_generated/api";
import type { WeatherReport } from "../../convex/tools/weather";
import type { Outfit } from "../../convex/workflows/outfit";
import { weatherQuestion } from "../../convex/workflows/prompts";
import { groupTurns, parseOutfit, replyView, type Turn } from "./turns";

export function WeatherFashion() {
  const selection = useSelectionState();
  return (
    <SelectionContext value={selection}>
      <div className="max-w-4xl mx-auto flex flex-col gap-12">
        <StartForm />
        <CurrentThread />
        <PreviousThreads />
      </div>
    </SelectionContext>
  );
}

/**
 * Which thread is on screen. `question` is the one just asked, shown until
 * the thread can show it itself, so it doesn't blink away while loading.
 */
type Selection =
  | { kind: "none" }
  | { kind: "asking"; question: string }
  | { kind: "thread"; threadId: string; question?: string };

function useSelectionState() {
  const [selection, setSelection] = useState<Selection>({ kind: "none" });
  return useMemo(
    () => ({
      selection,
      ask: (question: string) => setSelection({ kind: "asking", question }),
      started: (threadId: string) =>
        setSelection((s) => ({
          kind: "thread",
          threadId,
          question: s.kind === "asking" ? s.question : undefined,
        })),
      // Only undo the ask; leave a thread picked in the meantime alone.
      failed: () =>
        setSelection((s) => (s.kind === "asking" ? { kind: "none" } : s)),
      select: (threadId: string) => setSelection({ kind: "thread", threadId }),
    }),
    [selection],
  );
}

const SelectionContext = createContext<ReturnType<
  typeof useSelectionState
> | null>(null);

function useSelection() {
  const value = useContext(SelectionContext);
  if (!value) throw new Error("useSelection must be inside <WeatherFashion>");
  return value;
}

function CurrentThread() {
  const { selection } = useSelection();
  if (selection.kind === "asking") {
    return <PendingTurn question={selection.question} />;
  }
  if (selection.kind === "thread") {
    return (
      <WorkflowThread
        key={selection.threadId}
        threadId={selection.threadId}
        pendingQuestion={selection.question}
      />
    );
  }
  return null;
}

function StartForm() {
  const { ask, started, failed } = useSelection();
  const [location, setLocation] = useState("");
  const startWorkflow = useMutation(api.workflows.chaining.startWorkflow);
  return (
    <form
      className="max-w-lg mx-auto w-full flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const value = location.trim();
        if (!value) return;
        setLocation("");
        // Show the question now, the way chat apps do; the server saves the
        // same text in `startWorkflow`.
        ask(weatherQuestion(value));
        startWorkflow({ location: value })
          .then(({ threadId }) => started(threadId))
          .catch((error) => {
            console.error(error);
            failed();
            setLocation(value);
          });
      }}
    >
      <label htmlFor="location" className="sr-only">
        Location
      </label>
      <input
        id="location"
        value={location}
        onChange={(e) => setLocation(e.target.value)}
        className="flex-1 px-4 py-3 rounded-lg border-2 border-indigo-100 text-lg focus:outline-hidden focus:border-indigo-500"
        placeholder="Where do you want an outfit for?"
      />
      <button
        type="submit"
        disabled={!location.trim()}
        className="px-5 py-3 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-500 disabled:opacity-50"
      >
        Get outfit
      </button>
    </form>
  );
}

export function WorkflowThread({
  threadId,
  pendingQuestion,
}: {
  threadId: string;
  /** Shown while the thread loads, so the question doesn't blink away. */
  pendingQuestion?: string;
}) {
  // The shared streaming query from chat/streaming.ts.
  const { results, status, loadMore } = useUIMessages(
    api.chat.streaming.listThreadMessages,
    { threadId },
    { initialNumItems: 20, stream: true },
  );
  const workflow = useQuery(api.workflows.weatherFashion.workflowStatus, {
    threadId,
  });
  // Still loading counts as running, so a retry never flashes an error.
  const workflowRunning =
    workflow === undefined || workflow?.type === "inProgress";
  const turns = groupTurns(results);
  const hasOutfit = turns.some(
    (t) => t.reply?.status === "success" && parseOutfit(t.reply.text),
  );

  if (status === "LoadingFirstPage") {
    return pendingQuestion ? (
      <PendingTurn question={pendingQuestion} />
    ) : (
      <Typing label="Loading conversation…" />
    );
  }
  return (
    <section className="flex flex-col gap-6" aria-label="Workflow">
      {status === "CanLoadMore" && (
        <button
          className="self-center text-sm text-indigo-700"
          onClick={() => loadMore(20)}
        >
          Load earlier messages
        </button>
      )}
      {turns.map((turn, i) => {
        const isLatest = i === turns.length - 1;
        return (
          <TurnView
            key={turn.order}
            threadId={threadId}
            turn={turn}
            isLatest={isLatest}
            workflowRunning={workflowRunning}
            // The workflow's failure belongs to whatever turn it stopped on.
            workflowError={
              isLatest && workflow?.type === "failed" ? workflow.error : null
            }
          />
        );
      })}
      {hasOutfit && <FollowUpForm threadId={threadId} />}
    </section>
  );
}

function TurnView({
  threadId,
  turn,
  isLatest,
  workflowRunning,
  workflowError,
}: {
  threadId: string;
  turn: Turn;
  isLatest: boolean;
  workflowRunning: boolean;
  workflowError: string | null;
}) {
  const view = replyView(turn, { isLatest, workflowRunning });
  // A follow-up may be waiting for a free slot in the workpool.
  const queued = useQuery(
    api.workflows.weatherFashion.followUpQueued,
    view.kind === "working" && turn.prompt
      ? { threadId, promptMessageId: turn.prompt.id }
      : "skip",
  );
  // Until the answer has text to show, the dots stand in for it: through
  // queueing, the reply starting, and its tool calls. They sit in one slot,
  // so React keeps the same element the whole time and nothing moves.
  const waiting =
    view.kind === "working" || (view.kind === "answer" && !view.message.text);
  return (
    <div className="flex flex-col gap-3">
      {turn.prompt && <Question text={turn.prompt.text} />}
      {waiting && (
        <Typing label={queued ? "Queued…" : "Working…"} visible={!!queued} />
      )}
      {view.kind === "answer" && !waiting && (
        <Reply threadId={threadId} message={view.message} />
      )}
      {view.kind === "failed" && (
        <FailedReply
          threadId={threadId}
          partial={view.message}
          promptMessageId={turn.prompt?.id}
          workflowError={workflowError}
        />
      )}
    </div>
  );
}

function Reply({
  threadId,
  message,
}: {
  threadId: string;
  message: UIMessage;
}) {
  const streaming = message.status === "streaming";
  const [text] = useSmoothText(message.text, { startStreaming: streaming });
  const [reasoning] = useSmoothText(
    message.parts
      .filter((p) => p.type === "reasoning")
      .map((p) => p.text)
      .join("\n"),
    { startStreaming: streaming },
  );
  const abortStreamByOrder = useMutation(
    api.chat.streamAbort.abortStreamByOrder,
  );
  const outfit = streaming ? undefined : parseOutfit(message.text);
  return (
    <article className="rounded-xl border border-indigo-100 bg-white p-5 shadow-xs">
      {message.agentName && (
        <span className="mb-3 inline-block rounded-full bg-indigo-50 px-3 py-1 text-sm font-medium text-indigo-700">
          {message.agentName}
        </span>
      )}
      {reasoning && (
        <details className="mb-3 text-sm text-gray-500">
          <summary className="cursor-pointer">Thinking</summary>
          <p className="whitespace-pre-wrap">{reasoning}</p>
        </details>
      )}
      {/* {tools.length > 0 && (
        <ul className="mb-3 flex flex-col gap-1 text-sm text-gray-600">
          {tools.map((part) => (
            <ToolStep key={part.toolCallId} part={part} />
          ))}
        </ul>
      )} */}
      {outfit ? (
        <OutfitCard outfit={outfit} />
      ) : (
        <div className="prose prose-indigo max-w-none">
          <ReactMarkdown>{text}</ReactMarkdown>
        </div>
      )}
      {streaming && (
        <button
          className="mt-3 text-sm text-gray-600 hover:text-gray-900"
          onClick={() =>
            void abortStreamByOrder({ threadId, order: message.order })
          }
        >
          Stop
        </button>
      )}
    </article>
  );
}

/** A question with the typing dots under it, before there's a thread to show. */
function PendingTurn({ question }: { question: string }) {
  return (
    <section className="flex flex-col gap-3" aria-label="Workflow">
      <Question text={question} />
      <Typing label="Working…" />
    </section>
  );
}

function Question({ text }: { text: string }) {
  return (
    <p className="self-end max-w-lg rounded-lg bg-indigo-50 px-4 py-2 text-indigo-900">
      {text}
    </p>
  );
}

/** Tailwind's `animate-bounce` runs for one second. */
const BOUNCE_MS = 1000;

/**
 * Three pulsing dots where the answer will appear, like chat apps use
 * instead of a status word. Screen readers still hear `label`.
 */
function Typing({
  label,
  visible = false,
}: {
  label: string;
  visible?: boolean;
}) {
  // A new <Typing> mounts at each stage. Starting it mid-bounce, in step with
  // the clock, keeps the swap from restarting the animation visibly.
  const [phase] = useState(() => performance.now() % BOUNCE_MS);
  return (
    <p
      role="status"
      className="flex h-6 items-center gap-2 text-sm text-gray-500"
    >
      <span aria-hidden className="flex gap-1">
        {[0, 150, 300].map((delay) => (
          <span
            key={delay}
            className="size-1.5 animate-bounce rounded-full bg-gray-400"
            style={{ animationDelay: `${delay - phase}ms` }}
          />
        ))}
      </span>
      <span className={visible ? undefined : "sr-only"}>{label}</span>
    </p>
  );
}

function FailedReply({
  threadId,
  partial,
  promptMessageId,
  workflowError,
}: {
  threadId: string;
  partial?: UIMessage;
  promptMessageId?: string;
  workflowError: string | null;
}) {
  const retryWorkflow = useMutation(api.workflows.weatherFashion.retryWorkflow);
  const retryFollowUp = useMutation(api.workflows.weatherFashion.retryFollowUp);
  const [retrying, setRetrying] = useState(false);
  const retry = () => {
    setRetrying(true);
    const request = workflowError
      ? retryWorkflow({ threadId })
      : promptMessageId
        ? retryFollowUp({ threadId, promptMessageId })
        : Promise.resolve(null);
    request.catch(console.error).finally(() => setRetrying(false));
  };
  const canRetry = Boolean(workflowError || promptMessageId);
  return (
    <article className="rounded-xl border border-indigo-100 bg-white p-5 shadow-xs">
      {partial?.text && (
        <div className="prose prose-indigo max-w-none mb-3">
          <ReactMarkdown>{partial.text}</ReactMarkdown>
        </div>
      )}
      <p role="alert" className="text-gray-700">
        {partial?.text
          ? "This answer didn't finish."
          : "Couldn't finish this answer."}
      </p>
      <div className="mt-3 flex items-center gap-4">
        {canRetry && (
          <button
            className="px-3 py-1.5 rounded-lg border border-indigo-200 text-sm text-indigo-700 hover:bg-indigo-50 disabled:opacity-50"
            onClick={retry}
            disabled={retrying}
          >
            Retry
          </button>
        )}
        {workflowError && (
          <details className="text-sm text-gray-500">
            <summary className="cursor-pointer">Details</summary>
            <p className="mt-1">{workflowError}</p>
          </details>
        )}
      </div>
    </article>
  );
}

function ToolStep({ part }: { part: ToolUIPart | DynamicToolUIPart }) {
  const name = getToolName(part);
  if (part.state === "output-error") {
    return (
      <li className="text-red-700">
        {name} failed: {part.errorText}
      </li>
    );
  }
  if (part.state !== "output-available") {
    return <li>Calling {name}…</li>;
  }
  if (name === "getWeather") {
    const w = part.output as WeatherReport;
    return (
      <li>
        Weather: {w.temperature} (feels like {w.feelsLike}), {w.description},
        wind {w.windSpeed}
      </li>
    );
  }
  if (name === "getGeocoding") {
    const place = part.output as { name: string };
    return <li>Found {place.name}</li>;
  }
  return <li>Used {name}</li>;
}

function OutfitCard({ outfit }: { outfit: Outfit }) {
  const rows: [string, string][] = [
    ["Hat", outfit.hat],
    ["Tops", outfit.tops],
    ["Bottoms", outfit.bottoms],
    ["Shoes", outfit.shoes],
  ];
  return (
    <dl
      className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2"
      aria-label="Outfit"
    >
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="font-medium text-indigo-700">{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function FollowUpForm({ threadId }: { threadId: string }) {
  const [prompt, setPrompt] = useState("");
  const askFollowUp = useMutation(
    api.workflows.weatherFashion.askFollowUp,
  ).withOptimisticUpdate(
    optimisticallySendMessage(api.chat.streaming.listThreadMessages),
  );
  return (
    <form
      className="flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const value = prompt.trim();
        if (!value) return;
        setPrompt("");
        askFollowUp({ threadId, prompt: value }).catch(() => setPrompt(value));
      }}
    >
      <label htmlFor="followup" className="sr-only">
        Follow-up question
      </label>
      <input
        id="followup"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        className="flex-1 px-4 py-2 rounded-lg border-2 border-indigo-100 focus:outline-hidden focus:border-indigo-500"
        placeholder="Ask the fashion agent a follow-up…"
      />
      <button
        type="submit"
        disabled={!prompt.trim()}
        className="px-4 py-2 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-500 disabled:opacity-50"
      >
        Send
      </button>
    </form>
  );
}

function PreviousThreads() {
  const { select } = useSelection();
  const threads = usePaginatedQuery(
    api.threads.listThreads,
    {},
    { initialNumItems: 10 },
  );
  return (
    <section>
      <h2 className="text-2xl font-bold text-center mb-6 text-indigo-700">
        Previous threads
      </h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {threads.results.map((thread) => (
          <button
            key={thread._id}
            className="flex flex-col p-4 rounded-lg border bg-white text-left hover:border-indigo-500"
            onClick={() => select(thread._id)}
          >
            <span className="font-semibold line-clamp-2">
              {thread.title || "Untitled thread"}
            </span>
            <span className="text-xs text-gray-500 mt-2">
              {new Date(thread._creationTime).toLocaleDateString()}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
