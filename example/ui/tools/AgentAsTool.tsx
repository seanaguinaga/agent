import { useAction } from "convex/react";
import { api } from "../../convex/_generated/api";
import {
  ExamplePage,
  Result,
  TaskError,
  useExampleTask,
} from "../components/Example";

export default function AgentAsTool() {
  const run = useAction(api.tools.agentAsTool.runAgentAsTool);
  const task = useExampleTask();
  return (
    <ExamplePage
      title="Agent as a tool"
      description="A dispatch agent delegates to a second agent: doSomething three times and doSomethingElse once. A real tool-capable model is needed to exercise delegation."
    >
      <div className="demo-panel">
        <p>
          The nested agent runs in its own thread. The dispatch agent's final
          answer appears below.
        </p>
        <button
          className="demo-button"
          disabled={task.pending}
          onClick={() => void task.run(() => run({}))}
        >
          {task.pending ? "Running agents…" : "Run delegation example"}
        </button>
        <TaskError error={task.error} />
      </div>
      <Result value={task.result} />
    </ExamplePage>
  );
}
