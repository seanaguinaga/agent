import { PromptForm } from "./PromptForm";
import {
  SelectionProvider,
  useRecentThreads,
  useSelection,
  useStartWorkflow,
} from "./selection";
import { WorkflowThread } from "./Thread";
import { PendingTurn } from "./primitives";

export { WorkflowThread };

export function WeatherFashion() {
  return (
    <SelectionProvider>
      <div className="max-w-4xl mx-auto flex flex-col gap-12">
        <StartForm />
        <CurrentThread />
        <PreviousThreads />
      </div>
    </SelectionProvider>
  );
}

function StartForm() {
  const start = useStartWorkflow();
  return (
    <PromptForm
      id="location"
      label="Location"
      placeholder="Where do you want an outfit for?"
      submitLabel="Get outfit"
      size="lg"
      className="max-w-lg mx-auto w-full"
      onSubmit={start}
    />
  );
}

function CurrentThread() {
  const { selection } = useSelection();
  switch (selection.kind) {
    case "asking":
      return <PendingTurn question={selection.question} />;
    case "thread":
      return (
        <WorkflowThread
          key={selection.threadId}
          threadId={selection.threadId}
          pendingQuestion={selection.question}
        />
      );
    case "none":
      return null;
  }
}

function PreviousThreads() {
  const { select } = useSelection();
  const threads = useRecentThreads();
  return (
    <section>
      <h2 className="text-2xl font-bold text-center mb-6 text-indigo-700">
        Previous threads
      </h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {threads.map((thread) => (
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
