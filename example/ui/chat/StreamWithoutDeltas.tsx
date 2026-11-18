import { useAction } from "convex/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import {
  ExamplePage,
  Result,
  TaskError,
  useExampleTask,
} from "../components/Example";

export default function StreamWithoutDeltas() {
  const generate = useAction(api.chat.streaming.streamTextWithoutSavingDeltas);
  const [prompt, setPrompt] = useState(
    "Tell a story about a birthday party on Mars.",
  );
  const task = useExampleTask();
  return (
    <ExamplePage
      title="Streaming without saved deltas"
      description="The backend consumes the stream and saves the completed message. This client receives the final text and tool results after generation finishes."
    >
      <form
        className="demo-panel"
        onSubmit={(event) => {
          event.preventDefault();
          void task.run(() => generate({ prompt: prompt.trim() }));
        }}
      >
        <label className="demo-label" htmlFor="prompt">
          Story prompt
        </label>
        <textarea
          id="prompt"
          className="input-field"
          rows={3}
          value={prompt}
          disabled={task.pending}
          onChange={(event) => setPrompt(event.target.value)}
        />
        <button
          className="demo-button"
          disabled={task.pending || !prompt.trim()}
        >
          {task.pending ? "Generating…" : "Generate story"}
        </button>
        <TaskError error={task.error} />
      </form>
      <Result value={task.result} />
    </ExamplePage>
  );
}
