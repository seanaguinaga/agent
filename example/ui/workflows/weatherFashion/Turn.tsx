import { FailedReply } from "./FailedReply";
import { Reply } from "./Reply";
import { useFollowUpQueued, useWorkflowStatus } from "./threadData";
import { replyView, type Turn } from "./turns";
import { Question, Typing } from "./primitives";

export function TurnView({ turn, isLatest }: { turn: Turn; isLatest: boolean }) {
  const workflow = useWorkflowStatus();
  const view = replyView(turn, { isLatest, workflowRunning: workflow.running });
  const queued = useFollowUpQueued(turn, view.kind === "working");
  // Until the answer has text to show, the dots stand in for it: through
  // queueing, the reply starting, and its tool calls. They sit in one slot,
  // so React keeps the same element the whole time and nothing moves.
  const waiting =
    view.kind === "working" || (view.kind === "answer" && !view.message.text);
  return (
    <div className="flex flex-col gap-3">
      {turn.prompt && <Question text={turn.prompt.text} />}
      {waiting && (
        <Typing label={queued ? "Queued…" : "Working…"} visible={queued} />
      )}
      {view.kind === "answer" && !waiting && <Reply message={view.message} />}
      {view.kind === "failed" && (
        <FailedReply turn={turn} partial={view.message} isLatest={isLatest} />
      )}
    </div>
  );
}
