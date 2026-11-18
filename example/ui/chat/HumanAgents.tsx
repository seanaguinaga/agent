import { useAction, useMutation, usePaginatedQuery } from "convex/react";
import { useEffect, useState } from "react";
import type { FunctionReturnType } from "convex/server";
import { Link, useSearchParams } from "react-router-dom";
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
      description="Send a customer message, answer support requests, and watch the AI continue with the human's reply."
    >
      <ExampleBoundary>
        <HumanInbox />
      </ExampleBoundary>
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
      {threadId && <DeleteConversation threadId={threadId} />}
      {threadId && <HumanConversation key={threadId} threadId={threadId} />}
    </ExamplePage>
  );
}

function HumanInbox() {
  const inbox = usePaginatedQuery(
    api.chat.human.listInbox,
    {},
    { initialNumItems: 10 },
  );
  const { status, loadMore } = inbox;
  useEffect(() => {
    if (status === "CanLoadMore") loadMore(10);
  }, [status, loadMore]);
  return (
    <section className="demo-panel" aria-label="Human inbox">
      <div>
        <h2 className="text-xl font-semibold">Human inbox</h2>
        <p className="mt-1 text-sm text-gray-500">
          Select a request to view its conversation and send a reply here.
        </p>
      </div>
      {inbox.results.length === 0 ? (
        inbox.status === "Exhausted" ? (
          <p className="text-gray-500">No requests waiting for a human.</p>
        ) : (
          <p role="status">Finding support requests…</p>
        )
      ) : (
        <ul className="space-y-2">
          {inbox.results.map((request) => (
            <InboxRequest
              key={`${request.threadId}-${request.toolCallId}`}
              request={request}
            />
          ))}
        </ul>
      )}
      {inbox.results.length > 0 && inbox.status !== "Exhausted" && (
        <p role="status" className="text-sm text-gray-500">
          Finding remaining requests…
        </p>
      )}
      {inbox.results.length > 0 && (
        <p className="text-xs text-gray-500">
          Delete conversation removes its messages too. To keep the
          conversation, use Cancel request in the chat.
        </p>
      )}
    </section>
  );
}

function InboxRequest({
  request,
}: {
  request: FunctionReturnType<typeof api.chat.human.listInbox>["page"][number];
}) {
  const [params] = useSearchParams();
  return (
    <li className="space-y-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
        <Link
          to={`?thread=${encodeURIComponent(request.threadId)}`}
          aria-current={
            params.get("thread") === request.threadId ? "location" : undefined
          }
          className="min-w-0 flex-1 rounded-lg border p-4 hover:border-blue-400 aria-[current=location]:border-blue-500 aria-[current=location]:bg-blue-50"
        >
          <span className="text-xs font-semibold uppercase tracking-wide text-amber-700">
            Waiting for human
          </span>
          <p className="mt-1 break-words font-medium">{request.question}</p>
          <p className="mt-2 text-xs text-gray-500">
            {request.threadTitle} ·{" "}
            {new Date(request.createdAt).toLocaleString()}
          </p>
        </Link>
        <DeleteConversation threadId={request.threadId} />
      </div>
      {params.get("thread") === request.threadId && (
        <InboxReply
          threadId={request.threadId}
          toolCallId={request.toolCallId}
        />
      )}
    </li>
  );
}

function DeleteConversation({ threadId }: { threadId: string }) {
  const remove = useMutation(api.chat.human.deleteConversation);
  const [, setParams] = useSearchParams();
  const task = useExampleTask();
  return (
    <div className="space-y-2">
      <button
        type="button"
        className="demo-secondary text-red-700"
        title="Delete this conversation and its messages"
        disabled={task.pending}
        onClick={() =>
          void task.run(async () => {
            await remove({ threadId });
            setParams(
              (current) => {
                if (current.get("thread") !== threadId) return current;
                const next = new URLSearchParams(current);
                next.delete("thread");
                return next;
              },
              { replace: true },
            );
          })
        }
      >
        {task.pending ? "Deleting…" : "Delete conversation"}
      </button>
      <TaskError error={task.error} />
    </div>
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
  const [sender, setSender] = useState("ai");
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
        <div>
          <h2 className="font-semibold">Customer message</h2>
          <p className="mt-1 text-sm text-gray-500">
            The assistant can ask support for help. Support can reply from the
            inbox above.
          </p>
        </div>
        <details className="space-y-3 text-sm">
          <summary className="cursor-pointer text-gray-500">
            Other message examples
          </summary>
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
          {sender === "human" && (
            <>
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
            </>
          )}
        </details>
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
    </>
  );
}

function InboxReply({
  threadId,
  toolCallId,
}: {
  threadId: string;
  toolCallId: string;
}) {
  const respond = useMutation(api.chat.human.respondToTool);
  const [humanName, setHumanName] = useState("Support agent");
  const [response, setResponse] = useState("");
  const task = useExampleTask();
  return (
    <form
      className="space-y-3 rounded-lg border bg-gray-50 p-4"
      aria-label="Support reply"
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
      <label className="demo-label" htmlFor={`response-${toolCallId}`}>
        Your reply
      </label>
      <textarea
        id={`response-${toolCallId}`}
        className="input-field bg-white"
        rows={3}
        placeholder="Write a reply for the customer…"
        value={response}
        disabled={task.pending}
        onChange={(event) => setResponse(event.target.value)}
      />
      <details className="space-y-2 text-sm">
        <summary className="cursor-pointer text-gray-500">
          Reply as {humanName || "support"}
        </summary>
        <label className="demo-label" htmlFor={`name-${toolCallId}`}>
          Your name
        </label>
        <input
          id={`name-${toolCallId}`}
          className="input-field"
          value={humanName}
          disabled={task.pending}
          onChange={(event) => setHumanName(event.target.value)}
        />
      </details>
      <button
        className="demo-button"
        disabled={task.pending || !response.trim() || !humanName.trim()}
      >
        {task.pending ? "Sending reply…" : "Send reply"}
      </button>
      <TaskError error={task.error} />
    </form>
  );
}
