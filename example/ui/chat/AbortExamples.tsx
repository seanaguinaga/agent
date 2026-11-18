import { useAction, useMutation } from "convex/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import { ExamplePage, TaskError, useExampleTask } from "../components/Example";
import Transcript from "./Transcript";

export default function AbortExamples() {
  const byOrder = useAction(api.chat.streamAbort.streamThenAbortAsync);
  const bySignal = useAction(api.chat.streamAbort.streamThenUseAbortSignal);
  const createThread = useMutation(api.threads.createNewThread);
  const [method, setMethod] = useState("order");
  const [threadId, setThreadId] = useState<string>();
  const task = useExampleTask();
  return (
    <ExamplePage
      title="Automatic stream cancellation"
      description="Compare stopping a stream after its first chunk with cancelling via AbortController after one second. The essay and its final status remain visible."
    >
      <form
        className="demo-panel"
        onSubmit={(event) => {
          event.preventDefault();
          void task.run(async () => {
            const id = await createThread({ title: "Stream cancellation" });
            setThreadId(id);
            return method === "order"
              ? byOrder({ threadId: id })
              : bySignal({ threadId: id });
          });
        }}
      >
        <label className="demo-label" htmlFor="method">
          Cancellation method
        </label>
        <select
          id="method"
          className="input-field"
          value={method}
          disabled={task.pending}
          onChange={(event) => setMethod(event.target.value)}
        >
          <option value="order">Abort by stream order after first chunk</option>
          <option value="signal">AbortSignal after one second</option>
        </select>
        <button className="demo-button" disabled={task.pending}>
          {task.pending ? "Running cancellation…" : "Start essay and cancel"}
        </button>
        <TaskError error={task.error} />
      </form>
      {threadId && <Transcript threadId={threadId} />}
    </ExamplePage>
  );
}
