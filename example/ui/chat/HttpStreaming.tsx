import { useEffect, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { ExamplePage, TaskError } from "../components/Example";
import Transcript from "./Transcript";

export default function HttpStreaming() {
  const createThread = useMutation(api.threads.createNewThread);
  const [threadId, setThreadId] = useState<string>();
  const [prompt, setPrompt] = useState("Tell me a story about a lighthouse.");
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function send() {
    if (pending || !prompt.trim()) return;
    const request = new AbortController();
    controller.current = request;
    setPending(true);
    setError(undefined);
    setText("");
    try {
      const id = threadId ?? (await createThread({ title: "HTTP streaming" }));
      setThreadId(id);
      const response = await fetch(
        `${import.meta.env.VITE_CONVEX_SITE_URL}/streamText`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ threadId: id, prompt: prompt.trim() }),
          signal: request.signal,
        },
      );
      if (!response.ok || !response.body)
        throw new Error(`HTTP stream failed: ${response.status}`);
      const reader = response.body
        .pipeThrough(new TextDecoderStream())
        .getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          setText((previous) => previous + value);
        }
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      if (!request.signal.aborted) {
        console.error(error);
        setError(
          "The HTTP stream failed. Check the local backend and retry; your prompt has been kept.",
        );
      }
    } finally {
      setPending(false);
      controller.current = null;
    }
  }
  return (
    <ExamplePage
      title="HTTP streaming"
      description="Read text chunks directly from the Convex HTTP endpoint. Stop disconnects this client; server generation may continue and the completed conversation is shown below."
    >
      <form
        className="demo-panel"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
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
          disabled={pending}
          onChange={(event) => setPrompt(event.target.value)}
        />
        <div className="flex gap-3">
          <button className="demo-button" disabled={pending || !prompt.trim()}>
            {pending ? "Streaming…" : "Stream story"}
          </button>
          <button
            type="button"
            className="demo-secondary"
            disabled={!pending}
            onClick={() => controller.current?.abort()}
          >
            Stop receiving
          </button>
        </div>
        <TaskError error={error} />
      </form>
      <div
        className="demo-panel whitespace-pre-wrap"
        role="status"
        aria-label="HTTP response"
      >
        {text || "Text chunks will appear here."}
      </div>
      {threadId && !pending && (
        <Transcript key={`${threadId}-${text.length}`} threadId={threadId} />
      )}
    </ExamplePage>
  );
}
