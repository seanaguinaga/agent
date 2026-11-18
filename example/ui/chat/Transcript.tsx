import { useUIMessages } from "@convex-dev/agent/react";
import {
  getToolName,
  isToolUIPart,
  type ToolUIPart,
  type DynamicToolUIPart,
} from "ai";
import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import {
  ExampleBoundary,
  TaskError,
  useExampleTask,
} from "../components/Example";

export default function Transcript({ threadId }: { threadId: string }) {
  return (
    <ExampleBoundary key={threadId}>
      <Messages threadId={threadId} />
    </ExampleBoundary>
  );
}

function Messages({ threadId }: { threadId: string }) {
  const messages = useUIMessages(
    api.chat.human.getMessages,
    { threadId },
    { initialNumItems: 20, stream: true },
  );
  return (
    <section
      className="space-y-3 rounded-xl border bg-white p-4"
      aria-label="Conversation"
    >
      {messages.status === "LoadingFirstPage" ? (
        <p role="status">Loading conversation…</p>
      ) : messages.results.length === 0 ? (
        <p className="text-gray-500">Send a message to start this example.</p>
      ) : null}
      {messages.status === "CanLoadMore" && (
        <button
          className="demo-secondary"
          onClick={() => messages.loadMore(20)}
        >
          Load earlier messages
        </button>
      )}
      {messages.results.map((message) => (
        <article
          key={message.key}
          className={`rounded-lg p-4 ${message.role === "user" ? "bg-blue-50" : "bg-gray-50"}`}
        >
          <div className="mb-2 flex justify-between text-xs font-semibold uppercase tracking-wide text-gray-500">
            <span>{message.role === "user" ? "You" : message.role}</span>
            {message.status !== "success" && (
              <span>
                {message.status === "streaming"
                  ? "Responding…"
                  : message.status}
              </span>
            )}
          </div>
          {message.parts.map((part, index) => {
            if (part.type === "step-start") return null;
            if (isToolUIPart(part) && getToolName(part) === "askHuman") {
              return (
                <SupportRequest key={index} threadId={threadId} part={part} />
              );
            }
            if (part.type === "text")
              return (
                <p className="whitespace-pre-wrap" key={index}>
                  {part.text}
                </p>
              );
            if (part.type === "reasoning")
              return (
                <details key={index}>
                  <summary>Reasoning</summary>
                  <p className="whitespace-pre-wrap text-sm">{part.text}</p>
                </details>
              );
            if (part.type === "file")
              return part.mediaType.startsWith("image/") ? (
                <img
                  key={index}
                  src={part.url}
                  alt={part.filename ?? "Agent image"}
                  className="my-3 max-h-96 max-w-full rounded-lg"
                />
              ) : (
                <a
                  className="link-text"
                  key={index}
                  href={part.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {part.filename ?? "Open file"}
                </a>
              );
            return (
              <details key={index} className="my-2">
                <summary className="cursor-pointer text-sm">
                  {part.type}
                </summary>
                <pre className="overflow-auto whitespace-pre-wrap break-words text-xs">
                  {JSON.stringify(part, null, 2)}
                </pre>
              </details>
            );
          })}
          {message.status === "failed" && (
            <p role="alert" className="mt-2 text-red-700">
              Generation failed. Check provider configuration and try another
              message.
            </p>
          )}
        </article>
      ))}
      {messages.status === "LoadingMore" && (
        <p role="status">Loading earlier messages…</p>
      )}
    </section>
  );
}

function SupportRequest({
  threadId,
  part,
}: {
  threadId: string;
  part: ToolUIPart | DynamicToolUIPart;
}) {
  const cancel = useMutation(api.chat.human.deleteRequest);
  const task = useExampleTask();
  if (part.state === "output-available")
    return (
      <div
        className="my-3 space-y-1 rounded-lg bg-white p-4"
        aria-label="Support request"
      >
        <p className="font-medium text-green-700">Support replied</p>
        <p className="whitespace-pre-wrap">
          {typeof part.output === "string"
            ? part.output
            : "A support reply was received."}
        </p>
      </div>
    );
  if (part.state === "output-error")
    return (
      <div
        className="my-3 space-y-1 rounded-lg bg-white p-4"
        aria-label="Support request"
      >
        <p className="font-medium text-gray-700">Support request closed</p>
        <p className="text-sm text-gray-500">No support answer was supplied.</p>
      </div>
    );
  if (part.state !== "input-available")
    return (
      <p role="status" className="my-3 text-sm text-gray-500">
        Preparing your question for support…
      </p>
    );
  return (
    <div
      className="my-3 space-y-3 rounded-lg bg-amber-50 p-4"
      aria-label="Support request"
    >
      <p className="font-medium text-amber-800">Waiting for support</p>
      <p className="text-sm text-gray-700">
        Your question is in the support inbox. Their reply will appear here.
      </p>
      <button
        type="button"
        className="text-sm font-medium text-gray-600 underline underline-offset-2 disabled:opacity-50"
        disabled={task.pending}
        onClick={() =>
          void task.run(() => cancel({ threadId, toolCallId: part.toolCallId }))
        }
      >
        {task.pending ? "Cancelling…" : "Cancel request"}
      </button>
      <TaskError error={task.error} />
    </div>
  );
}
