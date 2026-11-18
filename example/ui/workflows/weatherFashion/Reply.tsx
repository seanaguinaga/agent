import { useSmoothText, type UIMessage } from "@convex-dev/agent/react";
import { useAbortStream } from "./threadData";
import { parseOutfit } from "./turns";
import { Card, Markdown, OutfitCard } from "./primitives";

export function Reply({ message }: { message: UIMessage }) {
  const streaming = message.status === "streaming";
  return (
    <Card>
      {message.agentName && <AgentBadge name={message.agentName} />}
      <Reasoning message={message} streaming={streaming} />
      <ReplyBody message={message} streaming={streaming} />
      {streaming && <StopButton order={message.order} />}
    </Card>
  );
}

function AgentBadge({ name }: { name: string }) {
  return (
    <span className="mb-3 inline-block rounded-full bg-indigo-50 px-3 py-1 text-sm font-medium text-indigo-700">
      {name}
    </span>
  );
}

function Reasoning({
  message,
  streaming,
}: {
  message: UIMessage;
  streaming: boolean;
}) {
  const [reasoning] = useSmoothText(
    message.parts
      .filter((p) => p.type === "reasoning")
      .map((p) => p.text)
      .join("\n"),
    { startStreaming: streaming },
  );
  if (!reasoning) return null;
  return (
    <details className="mb-3 text-sm text-gray-500">
      <summary className="cursor-pointer">Thinking</summary>
      <p className="whitespace-pre-wrap">{reasoning}</p>
    </details>
  );
}

/** The outfit card once the fashion step's answer is done, else markdown. */
function ReplyBody({
  message,
  streaming,
}: {
  message: UIMessage;
  streaming: boolean;
}) {
  const [text] = useSmoothText(message.text, { startStreaming: streaming });
  const outfit = streaming ? undefined : parseOutfit(message.text);
  return outfit ? <OutfitCard outfit={outfit} /> : <Markdown>{text}</Markdown>;
}

function StopButton({ order }: { order: number }) {
  const abort = useAbortStream();
  return (
    <button
      className="mt-3 text-sm text-gray-600 hover:text-gray-900"
      onClick={() => void abort(order)}
    >
      Stop
    </button>
  );
}
