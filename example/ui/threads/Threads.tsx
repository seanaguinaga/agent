import { useAction, usePaginatedQuery } from "convex/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import {
  ExampleBoundary,
  ExamplePage,
  TaskError,
  useExampleTask,
} from "../components/Example";
import Transcript from "../chat/Transcript";

export default function Threads() {
  return (
    <ExamplePage
      title="Threads and history"
      description="Browse the demo user's conversations, inspect messages, and generate a title and summary from a conversation."
    >
      <ExampleBoundary>
        <ThreadList />
      </ExampleBoundary>
    </ExamplePage>
  );
}
function ThreadList() {
  const threads = usePaginatedQuery(
    api.threads.listThreads,
    {},
    { initialNumItems: 20 },
  );
  const [selected, setSelected] = useState<string>();
  return (
    <div className="grid gap-6 md:grid-cols-[240px_1fr]">
      <div className="space-y-2">
        {threads.status === "LoadingFirstPage" && (
          <p role="status">Loading conversations…</p>
        )}
        {threads.status !== "LoadingFirstPage" &&
          threads.results.length === 0 && (
            <p>No conversations yet. Start with a chat example.</p>
          )}
        {threads.results.map((thread) => (
          <button
            key={thread._id}
            aria-pressed={selected === thread._id}
            className={`w-full rounded-lg border p-3 text-left text-sm ${selected === thread._id ? "border-blue-500 bg-blue-50" : "bg-white hover:bg-gray-50"}`}
            onClick={() => setSelected(thread._id)}
          >
            {thread.title || "Untitled conversation"}
            {thread.summary && (
              <span className="mt-2 block text-xs text-gray-500">
                {thread.summary}
              </span>
            )}
          </button>
        ))}
        {threads.status === "CanLoadMore" && (
          <button
            className="demo-secondary"
            onClick={() => threads.loadMore(20)}
          >
            Load more conversations
          </button>
        )}
      </div>
      <div className="min-w-0 space-y-4">
        {selected ? (
          <>
            <SummarizeThread key={selected} threadId={selected} />
            <Transcript threadId={selected} />
          </>
        ) : (
          <p className="text-gray-500">Choose a conversation to inspect.</p>
        )}
      </div>
    </div>
  );
}
function SummarizeThread({ threadId }: { threadId: string }) {
  const summarize = useAction(api.threads.updateThreadTitle);
  const task = useExampleTask();
  return (
    <div className="space-y-3">
      <button
        className="demo-secondary"
        disabled={task.pending}
        onClick={() => void task.run(() => summarize({ threadId }))}
      >
        {task.pending ? "Summarizing…" : "Generate title and summary"}
      </button>
      <TaskError error={task.error} />
    </div>
  );
}
