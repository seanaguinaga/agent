import { useAction } from "convex/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import {
  ExampleBoundary,
  ExamplePage,
  Result,
  TaskError,
  useExampleTask,
} from "../components/Example";
import { useQuery } from "convex/react";
import Transcript from "../chat/Transcript";

export function AutoSaveImage() {
  const ask = useAction(api.files.autoSave.askAboutImage);
  const [file, setFile] = useState<File>();
  const [prompt, setPrompt] = useState("Describe this image.");
  const task = useExampleTask<{ threadId: string; result: string }>();
  return (
    <ExamplePage
      title="Automatic image saving"
      description="Send image bytes directly to an agent. The component stores and reuses the file automatically. Requires an image-capable model; choose an image under 1 MB for this action-based upload."
    >
      <form
        className="demo-panel"
        onSubmit={(event) => {
          event.preventDefault();
          if (!file) return;
          void task.run(async () => {
            if (!file.type.startsWith("image/") || file.size > 1_000_000)
              throw new Error("Choose an image under 1 MB");
            return ask({
              image: await file.arrayBuffer(),
              mediaType: file.type,
              prompt: prompt.trim(),
            });
          });
        }}
      >
        <label className="demo-label" htmlFor="image">
          Image (under 1 MB)
        </label>
        <input
          id="image"
          type="file"
          accept="image/*"
          disabled={task.pending}
          onChange={(event) => setFile(event.target.files?.[0])}
        />
        {file && file.size > 1_000_000 && (
          <p role="alert" className="text-red-700">
            Choose an image under 1 MB.
          </p>
        )}
        <label className="demo-label" htmlFor="prompt">
          Question
        </label>
        <input
          id="prompt"
          className="input-field"
          value={prompt}
          disabled={task.pending}
          onChange={(event) => setPrompt(event.target.value)}
        />
        <button
          className="demo-button"
          disabled={
            task.pending || !file || file.size > 1_000_000 || !prompt.trim()
          }
        >
          {task.pending ? "Uploading and analyzing…" : "Ask about image"}
        </button>
        <TaskError error={task.error} />
      </form>
      <Result value={task.result?.result} />
      {task.result && <Transcript threadId={task.result.threadId} />}
    </ExamplePage>
  );
}

export function GenerateImage() {
  const generate = useAction(api.files.generateImage.generate);
  const [prompt, setPrompt] = useState(
    "A tiny robot tending a rooftop garden, watercolor.",
  );
  const task = useExampleTask<{ threadId: string }>();
  return (
    <ExamplePage
      title="Image generation"
      description="Generate an image and save it as an assistant attachment. Uses the existing OpenAI image example and requires OPENAI_API_KEY on the backend. Each run makes a paid provider request."
    >
      <form
        className="demo-panel"
        onSubmit={(event) => {
          event.preventDefault();
          void task.run(() => generate({ prompt: prompt.trim() }));
        }}
      >
        <label className="demo-label" htmlFor="prompt">
          Image description
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
          {task.pending ? "Generating image…" : "Generate image"}
        </button>
        <TaskError error={task.error} />
      </form>
      {task.result && <Transcript threadId={task.result.threadId} />}
    </ExamplePage>
  );
}

export function FileMaintenance() {
  return (
    <ExamplePage
      title="Unused file cleanup"
      description="Read-only view of the first 100 unreferenced files. The existing hourly cron deletes files untouched for 24 hours; cleanup remains an internal operation."
    >
      <ExampleBoundary>
        <UnusedFiles />
      </ExampleBoundary>
    </ExamplePage>
  );
}
function UnusedFiles() {
  const data = useQuery(api.files.maintenance.unusedFiles, {});
  if (!data) return <p role="status">Loading unused files…</p>;
  return (
    <div className="demo-panel">
      <p>
        {data.files.length} unreferenced files in this page. Eligibility is
        evaluated when the query refreshes.
      </p>
      {!data.isDone && <p>More files exist beyond this preview.</p>}
      {data.files.length === 0 ? (
        <p className="text-gray-500">No unused files.</p>
      ) : (
        <ul className="space-y-3">
          {data.files.map((file) => (
            <li key={file.fileId} className="break-all rounded-lg border p-3">
              <code>{file.fileId}</code>
              <p className="text-sm text-gray-500">
                Last touched: {new Date(file.lastTouchedAt).toLocaleString()} ·{" "}
                {file.eligible
                  ? "Eligible for cleanup"
                  : "Retained until 24 hours old"}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
