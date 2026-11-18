import { useState } from "react";
import { useMutation } from "convex/react";
import { usePaginatedQuery } from "convex-helpers/react";
import ReactMarkdown from "react-markdown";
import {
  optimisticallySendMessage,
  useSmoothText,
  useUIMessages,
  type UIMessage,
} from "@convex-dev/agent/react";
import { getToolName, isToolUIPart, type DynamicToolUIPart, type ToolUIPart } from "ai";
import { api } from "../../convex/_generated/api";
import type { WeatherReport } from "../../convex/tools/weather";
import type { Outfit } from "../../convex/workflows/outfit";
import { groupTurns, parseOutfit, type Turn } from "./turns";

export function WeatherFashion() {
  const [threadId, setThreadId] = useState<string | null>(null);
  return (
    <div className="max-w-4xl mx-auto flex flex-col gap-12">
      <StartForm onStarted={setThreadId} />
      {threadId && <WorkflowThread key={threadId} threadId={threadId} />}
      <PreviousThreads onSelect={setThreadId} />
    </div>
  );
}

function StartForm({ onStarted }: { onStarted: (threadId: string) => void }) {
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
        startWorkflow({ location: value })
          .then(({ threadId }) => onStarted(threadId))
          .catch((error) => {
            console.error(error);
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

export function WorkflowThread({ threadId }: { threadId: string }) {
  const { results, status, loadMore } = useUIMessages(
    api.workflows.weatherFashion.listMessages,
    { threadId },
    { initialNumItems: 20, stream: true },
  );
  const turns = groupTurns(results);
  const hasOutfit = turns.some((t) => t.replies.some((r) => parseOutfit(r.text)));

  if (status === "LoadingFirstPage") {
    return <p role="status">Loading conversation…</p>;
  }
  return (
    <section className="flex flex-col gap-6" aria-label="Workflow">
      {status === "CanLoadMore" && (
        <button className="self-center text-sm text-indigo-700" onClick={() => loadMore(20)}>
          Load earlier messages
        </button>
      )}
      {turns.map((turn, i) => (
        <TurnView key={turn.order} turn={turn} isLatest={i === turns.length - 1} />
      ))}
      {hasOutfit && <FollowUpForm threadId={threadId} />}
    </section>
  );
}

function TurnView({ turn, isLatest }: { turn: Turn; isLatest: boolean }) {
  const waiting = turn.replies.length === 0;
  return (
    <div className="flex flex-col gap-3">
      {turn.prompt && (
        <p className="self-end max-w-lg rounded-lg bg-indigo-50 px-4 py-2 text-indigo-900">
          {turn.prompt.text}
        </p>
      )}
      {turn.earlierFailures > 0 && (
        <p className="text-sm text-gray-500">
          {turn.earlierFailures === 1
            ? "1 earlier attempt failed"
            : `${turn.earlierFailures} earlier attempts failed`}
        </p>
      )}
      {turn.replies.map((reply) => (
        <Reply key={reply.key} message={reply} retryable={isLatest} />
      ))}
      {waiting && isLatest && (
        <p role="status" className="text-gray-500">
          Working…
        </p>
      )}
    </div>
  );
}

function Reply({ message, retryable }: { message: UIMessage; retryable: boolean }) {
  const streaming = message.status === "streaming";
  const [text] = useSmoothText(message.text, { startStreaming: streaming });
  const outfit = streaming ? undefined : parseOutfit(message.text);
  const tools = message.parts.filter(isToolUIPart);
  return (
    <article className="rounded-xl border border-indigo-100 bg-white p-5 shadow-xs">
      {message.agentName && (
        <span className="mb-3 inline-block rounded-full bg-indigo-50 px-3 py-1 text-sm font-medium text-indigo-700">
          {message.agentName}
        </span>
      )}
      {tools.length > 0 && (
        <ul className="mb-3 flex flex-col gap-1 text-sm text-gray-600">
          {tools.map((part) => (
            <ToolStep key={part.toolCallId} part={part} />
          ))}
        </ul>
      )}
      {outfit ? (
        <OutfitCard outfit={outfit} />
      ) : text ? (
        <div className="prose prose-indigo max-w-none">
          <ReactMarkdown>{text}</ReactMarkdown>
        </div>
      ) : message.status === "pending" || streaming ? (
        <p role="status" className="text-gray-500">
          Thinking…
        </p>
      ) : null}
      {message.status === "failed" && (
        <p role="alert" className="mt-2 text-red-700">
          This attempt failed.
          {retryable && " The workflow may retry this step."}
        </p>
      )}
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
        Weather: {w.temperature} (feels like {w.feelsLike}), {w.description}, wind{" "}
        {w.windSpeed}
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
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2" aria-label="Outfit">
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
    optimisticallySendMessage(api.workflows.weatherFashion.listMessages),
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

function PreviousThreads({ onSelect }: { onSelect: (threadId: string) => void }) {
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
            onClick={() => onSelect(thread._id)}
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
