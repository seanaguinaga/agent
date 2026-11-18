import { useAction, useMutation } from "convex/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import { ExamplePage, TaskError, useExampleTask } from "../components/Example";
import Transcript from "../chat/Transcript";

export default function Chaining() {
  const createThread = useMutation(api.threads.createNewThread);
  const getAdvice = useAction(api.workflows.chaining.getAdvice);
  const [location, setLocation] = useState("San Francisco");
  const [threadId, setThreadId] = useState<string>();
  const task = useExampleTask();
  return (
    <ExamplePage
      title="Agent chaining in an action"
      description="Run the weather agent followed by the fashion agent in one action, sharing a conversation. Compare this with the durable workflow example."
    >
      <form
        className="demo-panel"
        onSubmit={(event) => {
          event.preventDefault();
          void task.run(async () => {
            const id = await createThread({ title: `Weather in ${location}` });
            setThreadId(id);
            await getAdvice({ threadId: id, location: location.trim() });
          });
        }}
      >
        <label className="demo-label" htmlFor="location">
          Location
        </label>
        <input
          id="location"
          className="input-field"
          value={location}
          disabled={task.pending}
          onChange={(event) => setLocation(event.target.value)}
        />
        <button
          className="demo-button"
          disabled={task.pending || !location.trim()}
        >
          {task.pending ? "Getting weather and advice…" : "Get outfit advice"}
        </button>
        <TaskError error={task.error} />
      </form>
      {threadId && <Transcript threadId={threadId} />}
    </ExamplePage>
  );
}
