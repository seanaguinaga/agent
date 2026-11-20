// The case's conversation, read through the case: only its owner (or the
// guest holding its key) gets the thread.
import { useUIMessages } from "@convex-dev/agent/react";
import type { Id } from "../../convex/_generated/dataModel";
import { api } from "../../convex/_generated/api";
import { ExampleBoundary } from "../components/Example";

type Props = { caseId: Id<"cases">; threadId: string; guestKey?: string };

export default function CaseTranscript(props: Props) {
  return (
    <ExampleBoundary key={props.caseId}>
      <Messages {...props} />
    </ExampleBoundary>
  );
}

function Messages({ caseId, threadId, guestKey }: Props) {
  const messages = useUIMessages(
    api.easygov.case.public.listMessages,
    { caseId, threadId, guestKey },
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
        <p className="text-gray-500">Nothing said yet.</p>
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
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
            {message.role === "user" ? "You" : "Intake"}
          </div>
          {message.parts.map((part, index) =>
            part.type === "text" ? (
              <p className="whitespace-pre-wrap" key={index}>
                {part.text}
              </p>
            ) : null,
          )}
        </article>
      ))}
    </section>
  );
}
