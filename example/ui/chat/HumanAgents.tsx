import { useAction, useMutation } from "convex/react";
import { useUIMessages } from "@convex-dev/agent/react";
import { isToolUIPart, getToolName } from "ai";
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../../convex/_generated/api";
import {
  ExampleBoundary,
  ExamplePage,
  TaskError,
  useExampleTask,
} from "../components/Example";
import Transcript from "./Transcript";

export default function HumanAgents() {
  const create = useMutation(api.threads.createNewThread);
  const [params, setParams] = useSearchParams();
  const threadId = params.get("thread") || undefined;
  const task = useExampleTask();
  return (
    <ExamplePage
      title="Human agents"
      description="Send a user message, reply as a human support agent, or ask the AI to request human input through a tool. Human tool requests require a tool-capable model."
    >
      <button
        className="demo-button"
        disabled={task.pending}
        onClick={() =>
          void task.run(async () => {
            const id = await create({ title: "Human handoff" });
            setParams({ thread: id });
          })
        }
      >
        {task.pending
          ? "Creating…"
          : threadId
            ? "New conversation"
            : "Start conversation"}
      </button>
      <TaskError error={task.error} />
      {threadId && <HumanConversation key={threadId} threadId={threadId} />}
    </ExamplePage>
  );
}

function HumanConversation({ threadId }: { threadId: string }) {
  const userMessage = useMutation(api.chat.human.sendMessageFromUser);
  const humanMessage = useMutation(api.chat.human.reply);
  const ask = useAction(api.chat.human.ask);
  const [message, setMessage] = useState(
    "Please ask a human whether I can get a refund.",
  );
  const [name, setName] = useState("Support agent");
  const [sender, setSender] = useState("user");
  const task = useExampleTask();
  return (
    <>
      <Transcript threadId={threadId} />
      <form
        className="demo-panel"
        onSubmit={(event) => {
          event.preventDefault();
          void task.run(async () => {
            if (sender === "user")
              await userMessage({ threadId, message: message.trim() });
            else if (sender === "human")
              await humanMessage({
                threadId,
                agentName: name.trim(),
                message: message.trim(),
              });
            else await ask({ threadId, question: message.trim() });
            setMessage("");
          });
        }}
      >
        <label className="demo-label" htmlFor="sender">
          Send as
        </label>
        <select
          id="sender"
          className="input-field"
          value={sender}
          disabled={task.pending}
          onChange={(event) => setSender(event.target.value)}
        >
          <option value="user">User · save without AI response</option>
          <option value="human">Human support · reply as assistant</option>
          <option value="ai">Ask AI · may request human help</option>
        </select>
        <label className="demo-label" htmlFor="human-name">
          Support agent name
        </label>
        <input
          id="human-name"
          className="input-field"
          value={name}
          disabled={task.pending}
          onChange={(event) => setName(event.target.value)}
        />
        <label className="demo-label" htmlFor="message">
          Message
        </label>
        <textarea
          id="message"
          className="input-field"
          value={message}
          rows={3}
          disabled={task.pending}
          onChange={(event) => setMessage(event.target.value)}
        />
        <button
          className="demo-button"
          disabled={
            task.pending ||
            !message.trim() ||
            (sender === "human" && !name.trim())
          }
        >
          {task.pending ? "Sending…" : "Send"}
        </button>
        <TaskError error={task.error} />
      </form>
      <ExampleBoundary>
        <HumanRequests threadId={threadId} humanName={name} />
      </ExampleBoundary>
    </>
  );
}

function HumanRequests({
  threadId,
  humanName,
}: {
  threadId: string;
  humanName: string;
}) {
  const messages = useUIMessages(
    api.chat.human.getMessages,
    { threadId },
    { initialNumItems: 100 },
  );
  const requests = messages.results.flatMap((message) =>
    message.parts
      .filter(isToolUIPart)
      .filter(
        (part) =>
          getToolName(part) === "askHuman" && part.state === "input-available",
      ),
  );
  return (
    <div className="space-y-3">
      <h2 className="font-semibold">Human tool requests</h2>
      {requests.length === 0 ? (
        <p className="text-sm text-gray-500">
          No pending requests in the latest 100 messages.
        </p>
      ) : (
        requests.map((request) => (
          <HumanResponse
            key={request.toolCallId}
            threadId={threadId}
            humanName={humanName}
            toolCallId={request.toolCallId}
            question={JSON.stringify(request.input)}
          />
        ))
      )}
    </div>
  );
}
function HumanResponse({
  threadId,
  humanName,
  toolCallId,
  question,
}: {
  threadId: string;
  humanName: string;
  toolCallId: string;
  question: string;
}) {
  const respond = useMutation(api.chat.human.respondToTool);
  const [response, setResponse] = useState("");
  const task = useExampleTask();
  return (
    <form
      className="demo-panel"
      onSubmit={(event) => {
        event.preventDefault();
        void task.run(() =>
          respond({
            threadId,
            humanName: humanName.trim(),
            toolCallId,
            response: response.trim(),
          }),
        );
      }}
    >
      <p>{question}</p>
      <label className="demo-label" htmlFor={`response-${toolCallId}`}>
        Human response
      </label>
      <textarea
        id={`response-${toolCallId}`}
        className="input-field"
        value={response}
        disabled={task.pending}
        onChange={(event) => setResponse(event.target.value)}
      />
      <button
        className="demo-button"
        disabled={task.pending || !response.trim() || !humanName.trim()}
      >
        {task.pending ? "Resuming…" : "Reply and resume AI"}
      </button>
      <TaskError error={task.error} />
    </form>
  );
}
