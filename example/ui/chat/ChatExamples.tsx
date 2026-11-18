import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useConvex, useMutation, useQuery } from "convex/react";
import type { FunctionReference } from "convex/server";
import { api } from "../../convex/_generated/api";
import {
  ExampleBoundary,
  ExamplePage,
  TaskError,
  useExampleTask,
} from "../components/Example";
import Transcript from "./Transcript";

type ChatProps = {
  title: string;
  description: string;
  initialPrompt?: string;
  abort?: boolean;
} & (
  | {
      kind: "mutation";
      send: FunctionReference<
        "mutation",
        "public",
        { threadId: string; prompt: string }
      >;
    }
  | {
      kind: "action";
      send:
        | FunctionReference<
            "action",
            "public",
            { threadId: string; prompt: string }
          >
        | typeof api.chat.streamingReasoning.streamReasoning;
    }
);

export default function ChatExamples(props: ChatProps) {
  const {
    title,
    description,
    initialPrompt = "Tell me a short story about a lost robot.",
    abort = false,
  } = props;
  const convex = useConvex();
  const createThread = useMutation(api.threads.createNewThread);
  const [params, setParams] = useSearchParams();
  const threadId = params.get("thread") || undefined;
  const [prompt, setPrompt] = useState(initialPrompt);
  const task = useExampleTask();
  return (
    <ExamplePage title={title} description={description}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void task.run(async () => {
            const id = threadId ?? (await createThread({ title }));
            setParams({ thread: id });
            const result =
              props.kind === "mutation"
                ? await convex.mutation(props.send, {
                    threadId: id,
                    prompt: prompt.trim(),
                  })
                : await convex.action(props.send, {
                    threadId: id,
                    prompt: prompt.trim(),
                  });
            setPrompt("");
            return result;
          });
        }}
        className="demo-panel"
      >
        <label className="demo-label" htmlFor="prompt">
          Message
        </label>
        <textarea
          id="prompt"
          className="input-field"
          rows={3}
          value={prompt}
          disabled={task.pending}
          onChange={(event) => setPrompt(event.target.value)}
        />
        <div className="flex flex-wrap gap-3">
          <button
            className="demo-button"
            disabled={task.pending || !prompt.trim()}
          >
            {task.pending ? "Sending…" : "Send message"}
          </button>
          <button
            className="demo-secondary"
            type="button"
            disabled={task.pending || !threadId}
            onClick={() => setParams({})}
          >
            New conversation
          </button>
        </div>
        <TaskError error={task.error} />
      </form>
      {threadId && (
        <>
          <ThreadTitle threadId={threadId} />
          {abort && (
            <ExampleBoundary>
              <StreamControls threadId={threadId} />
            </ExampleBoundary>
          )}
          <Transcript threadId={threadId} />
        </>
      )}
    </ExamplePage>
  );
}

function ThreadTitle({ threadId }: { threadId: string }) {
  return (
    <ExampleBoundary key={threadId}>
      <Title threadId={threadId} />
    </ExampleBoundary>
  );
}
function Title({ threadId }: { threadId: string }) {
  const thread = useQuery(api.threads.getThreadDetails, { threadId });
  return (
    <p className="text-sm text-gray-500">
      {thread?.title} <span className="break-all font-mono">{threadId}</span>
    </p>
  );
}

function StreamControls({ threadId }: { threadId: string }) {
  const streams = useQuery(api.chat.streamAbort.list, { threadId });
  const stop = useMutation(api.chat.streamAbort.abortStreamByOrder);
  const task = useExampleTask();
  return (
    <div className="demo-panel">
      <h2 className="font-semibold">Active streams</h2>
      {streams === undefined ? (
        <p role="status">Loading streams…</p>
      ) : streams.length === 0 ? (
        <p className="text-sm text-gray-500">
          No active streams. Send a long story, then stop it here.
        </p>
      ) : (
        streams.map((stream) => (
          <button
            key={stream.streamId}
            className="demo-secondary"
            disabled={task.pending}
            onClick={() =>
              void task.run(() => stop({ threadId, order: stream.order }))
            }
          >
            Stop stream {stream.order}
          </button>
        ))
      )}
      <TaskError error={task.error} />
    </div>
  );
}
