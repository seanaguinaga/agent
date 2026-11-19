// What a case's fields mean. Pure: no ctx and no I/O, so these are tested
// with plain values. The workflow waits on them, and `send` checks them, so
// both always agree on where the case is.
import type { Doc } from "../../_generated/dataModel";
import { fingerprint, missingInputs } from "./answers";
import type { WaitingFor } from "./schema";

export type Case = Doc<"cases">;

/** The goal, unless the selection made for it was rejected. */
export function standingGoal(c: Case): string | undefined {
  const { intake, processPack } = c;
  const rejected =
    processPack?.status === "rejected" &&
    processPack.goalVersion === intake?.version;
  return rejected ? undefined : intake?.goal;
}

/**
 * A newly stated goal. The version goes up even when the words are the same,
 * so a selection made (or rejected) for the goal before it is out of date.
 */
export function newGoal(c: Case, goal: string): Case["intake"] {
  return { goal, version: (c.intake?.version ?? 0) + 1 };
}

/** The selection made for the current goal. One for an earlier goal is none. */
export function currentSelection(c: Case) {
  const selection = c.processPack;
  return selection?.goalVersion === c.intake?.version ? selection : undefined;
}

/** The input keys the confirmed pack asks for. */
export function requiredInputs(c: Case): string[] | undefined {
  const selection = currentSelection(c);
  return selection?.status === "confirmed"
    ? selection.definition?.inputs
    : undefined;
}

/** "approved", "changed" (an answer moved on since the artifact), or null. */
export function reviewOutcome(c: Case): "approved" | "changed" | null {
  const current = fingerprint(c.answers);
  if (c.artifact?.fingerprint !== current) return "changed";
  return c.approval?.fingerprint === current ? "approved" : null;
}

/** What the case waits for a person to do; null if nothing right now. */
export function waitingFor(c: Case): WaitingFor {
  if (c.status !== "active" || c.failure) return null;
  if (!standingGoal(c)) return "goal";
  const selection = currentSelection(c);
  if (selection?.status === "proposed") return "pack";
  if (selection?.status !== "confirmed" || selection.referral) return null;
  const inputs = requiredInputs(c) ?? [];
  if (missingInputs(inputs, c.answers).length) return "answers";
  // All answered: in review once the artifact matches them, until approved.
  return reviewOutcome(c) === null ? "approval" : null;
}
