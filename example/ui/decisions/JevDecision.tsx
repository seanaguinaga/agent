import { useState } from "react";
import { useAction } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import {
  ExamplePage,
  Result,
  TaskError,
  useExampleTask,
} from "../components/Example";

type Decision = FunctionReturnType<typeof api.decisions.jev.triage>;
const sampleTickets = {
  Outage:
    "All customers are unable to sign in. The problem began after our latest release, and there is no workaround.",
  Bug: "The CSV export button fails in Safari, but exporting from Chrome still works. Only two users have reported it.",
  Question:
    "Where can I find the documentation for changing my profile picture?",
};

export default function JevDecision() {
  const triage = useAction(api.decisions.jev.triage);
  const [ticket, setTicket] = useState(sampleTickets.Outage);
  const task = useExampleTask<{ ticket: string; decision: Decision }>();
  return (
    <ExamplePage
      title="Jev decision model"
      description="Classify a support ticket with TypeSafe Jev. One request asks two independent questions: choose a priority and estimate whether human review is needed."
    >
      <form
        className="demo-panel"
        onSubmit={(event) => {
          event.preventDefault();
          if (!ticket.trim() || ticket.trim().length > 8000) return;
          void task.run(async () => {
            const submitted = ticket.trim();
            return {
              ticket: submitted,
              decision: await triage({ ticket: submitted }),
            };
          });
        }}
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-gray-500">Try a ticket:</span>
          {Object.entries(sampleTickets).map(([label, text]) => (
            <button
              type="button"
              className="demo-secondary"
              key={label}
              disabled={task.pending}
              onClick={() => setTicket(text)}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="demo-label" htmlFor="ticket">
          Support ticket
        </label>
        <textarea
          id="ticket"
          className="input-field"
          rows={5}
          maxLength={8000}
          value={ticket}
          disabled={task.pending}
          onChange={(event) => setTicket(event.target.value)}
        />
        <p className="text-sm text-gray-500">
          Requires Convex AI Gateway access on a paid team and a linked local
          deployment. Each evaluation makes a paid model request.
        </p>
        <button
          className="demo-button"
          disabled={task.pending || !ticket.trim()}
        >
          {task.pending ? "Evaluating ticket…" : "Evaluate with Jev"}
        </button>
        <TaskError error={task.error} />
      </form>
      {task.result && (
        <section
          className="space-y-4"
          aria-label="Decision result"
          aria-live="polite"
        >
          <div className="demo-panel">
            <h2 className="font-semibold">Evaluated ticket</h2>
            <p className="whitespace-pre-wrap break-words text-sm text-gray-600">
              {task.result.ticket}
            </p>
            <p className="text-xs text-gray-500">
              Model: {task.result.decision.model}
            </p>
          </div>
          <DecisionResult decision={task.result.decision} />
        </section>
      )}
      <p className="text-sm text-gray-500">
        These are model judgments; this demo does not route tickets or contact
        support. Results stay on this page until you reload. The Decisions
        endpoint is in alpha.
      </p>
      <a
        className="link-text inline-block text-sm"
        href="https://docs.convex.dev/ai-gateway/api#post-alphadecisions"
        target="_blank"
        rel="noreferrer"
      >
        Convex Decisions API documentation ↗
      </a>
    </ExamplePage>
  );
}

function DecisionResult({ decision }: { decision: Decision }) {
  const { priority, needsHuman } = decision.answers;
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="demo-panel">
          <h2 className="font-semibold">Priority choice</h2>
          <p className="text-3xl font-semibold capitalize text-blue-700">
            {priority.choice}
          </p>
          <p className="text-sm text-gray-500">
            Confidence:{" "}
            {priority.confidence === undefined
              ? "Not reported"
              : `${(priority.confidence * 100).toFixed(1)}%`}
          </p>
          {priority.probabilities && (
            <dl className="space-y-2">
              {Object.entries(priority.probabilities).map(
                ([choice, probability]) => (
                  <div
                    key={choice}
                    className="flex justify-between gap-4 text-sm"
                  >
                    <dt className="capitalize">{choice}</dt>
                    <dd>{(probability * 100).toFixed(1)}%</dd>
                  </div>
                ),
              )}
            </dl>
          )}
        </div>
        <div className="demo-panel">
          <h2 className="font-semibold">Human review probability</h2>
          <p className="text-3xl font-semibold text-blue-700">
            {(needsHuman.noul * 100).toFixed(1)}%
          </p>
          <p className="text-sm text-gray-500">
            Jev's estimate that the ticket needs human investigation or an
            account-specific decision. This is not the priority confidence.
          </p>
        </div>
      </div>
      <div className="demo-panel">
        <h2 className="font-semibold">Request usage</h2>
        <dl className="grid gap-4 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-gray-500">Input tokens</dt>
            <dd>{decision.usage?.input_tokens ?? "Not reported"}</dd>
          </div>
          <div>
            <dt className="text-gray-500">Output tokens</dt>
            <dd>{decision.usage?.output_tokens ?? "Not reported"}</dd>
          </div>
          <div>
            <dt className="text-gray-500">Cost (USD)</dt>
            <dd>
              {decision.usage?.cost === undefined
                ? "Not reported"
                : `$${decision.usage.cost.toFixed(6)}`}
            </dd>
          </div>
        </dl>
      </div>
      <details className="demo-panel">
        <summary className="cursor-pointer font-medium">
          Validated JSON response
        </summary>
        <Result value={decision} />
      </details>
    </>
  );
}
