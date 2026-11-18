import { useUIMessages } from "@convex-dev/agent/react";
import { api } from "../../convex/_generated/api";
import { ExampleBoundary } from "../components/Example";

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
            <span>{message.role}</span>
            <span>{message.status}</span>
          </div>
          {message.parts.map((part, index) => {
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
