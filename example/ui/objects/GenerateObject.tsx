import { useAction } from "convex/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import {
  ExamplePage,
  Result,
  TaskError,
  useExampleTask,
} from "../components/Example";

export default function GenerateObject() {
  const object = useAction(api.objects.generateObject.createObject);
  const array = useAction(api.objects.generateObject.createArray);
  const enumeration = useAction(api.objects.generateObject.createEnum);
  const [format, setFormat] = useState("object");
  const task = useExampleTask();
  return (
    <ExamplePage
      title="Structured output"
      description="Generate a sandwich plan as an object or array, or choose a value from an enum. Requires a model with structured output support."
    >
      <form
        className="demo-panel"
        onSubmit={(event) => {
          event.preventDefault();
          void task.run(() =>
            format === "object"
              ? object({})
              : format === "array"
                ? array({})
                : enumeration({}),
          );
        }}
      >
        <label className="demo-label" htmlFor="format">
          Output format
        </label>
        <select
          id="format"
          className="input-field"
          value={format}
          disabled={task.pending}
          onChange={(event) => setFormat(event.target.value)}
        >
          <option value="object">Object · summary and steps</option>
          <option value="array">Array · sandwich steps</option>
          <option value="enum">Enum · hello or world</option>
        </select>
        <button className="demo-button" disabled={task.pending}>
          {task.pending ? "Generating…" : "Generate output"}
        </button>
        <TaskError error={task.error} />
      </form>
      <Result value={task.result} />
    </ExamplePage>
  );
}
