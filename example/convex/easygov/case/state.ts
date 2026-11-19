// What a case's fields mean. Pure: no ctx and no I/O, so these are tested
// with plain values. The workflow waits on them, and `send` checks them, so
// both always agree on where the case is.
import type { Doc } from "../../_generated/dataModel";
import { addDays, fingerprint, missingInputs, passes } from "./answers";
import { chosen, type WaitingFor } from "./schema";

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

/** What was proposed or confirmed for the current goal. A rejection is none. */
export function currentChoice(c: Case) {
  return chosen(currentSelection(c));
}

/** The input keys the confirmed pack asks for. */
export function requiredInputs(c: Case): string[] | undefined {
  const selection = currentSelection(c);
  return selection?.status === "confirmed"
    ? selection.definition?.inputs
    : undefined;
}

/** The confirmed pack, as the case pinned it. */
export function pinnedPack(c: Case) {
  const selection = currentSelection(c);
  return selection?.status === "confirmed" ? selection.definition : undefined;
}

/** What was read from the conversation for the current goal, if started. */
function currentSuggested(c: Case) {
  return c.suggested?.goalVersion === c.intake?.version
    ? c.suggested
    : undefined;
}

/** True while the conversation is being read for answers. */
export function readingConversation(c: Case): boolean {
  const suggested = currentSuggested(c);
  return !!suggested && suggested.answers === undefined;
}

/**
 * The suggested answers still on offer: for the current goal's questions,
 * and only where the person hasn't answered yet.
 */
export function suggestions(c: Case): Record<string, string> {
  // What the person said just now outranks what the profile remembers.
  const found = { ...c.offers, ...currentSuggested(c)?.answers };
  return Object.fromEntries(
    missing(c)
      .filter((key) => found[key])
      .map((key) => [key, found[key]]),
  );
}

/** The confirmed pack's inputs the case has no answer for yet. */
export function missing(c: Case): string[] {
  return missingInputs(requiredInputs(c) ?? [], c.answers, c.fromProfile);
}

/** The keys of the required files the person hasn't attached yet. */
export function missingDocuments(c: Case): string[] {
  return (pinnedPack(c)?.documents ?? [])
    .filter(({ key, required }) => required && !c.documents[key])
    .map(({ key }) => key);
}

/** The answers and files as they stand: what a document is built from. */
export function fingerprintOf(c: Case): string {
  return fingerprint(c.answers, c.documents);
}

/** The date to act by, once the answer it's counted from is in. */
export function deadlineOf(
  c: Case,
): { label: string; date: string } | undefined {
  const deadline = pinnedPack(c)?.deadline;
  const from = deadline && c.answers[deadline.fromInput];
  const date = from ? addDays(from, deadline.days) : undefined;
  return date ? { label: deadline!.label, date } : undefined;
}

/**
 * What an answer to `key` must be, because the deadline or the referral
 * check reads it: a date, a number, or (undefined) any text.
 */
export function answerKind(
  c: Case,
  key: string,
): "date" | "number" | undefined {
  const pack = pinnedPack(c);
  if (pack?.deadline?.fromInput === key) return "date";
  const when = pack?.referral?.when;
  if (when?.input !== key) return undefined;
  if ("withinDays" in when) return "date";
  return "atLeast" in when ? "number" : undefined;
}

/** The referral to offer for the pack, if its check passes on this day. */
export function packReferral(c: Case, on: string): string | undefined {
  const referral = pinnedPack(c)?.referral;
  if (!referral) return undefined;
  return !referral.when || passes(referral.when, c.answers, on)
    ? referral.kind
    : undefined;
}

/** A case started without an account. */
export function isGuest(c: Pick<Case, "userId">): boolean {
  return c.userId.startsWith("guest:");
}

/** "approved", "changed" (an answer moved on since the artifact), or null. */
export function reviewOutcome(c: Case): "approved" | "changed" | null {
  const current = fingerprintOf(c);
  if (c.artifact?.fingerprint !== current) return "changed";
  return c.approval?.fingerprint === current ? "approved" : null;
}

/**
 * True when a write left the case waiting for the same thing. The workflow's
 * waits read the same fields as `waitingFor`, so it has nothing new to find,
 * and telling it to look again would only spend one of its looks.
 */
export function sameWait(before: Case, after: Case): boolean {
  const waiting = waitingFor(after);
  return (
    waiting !== null &&
    waiting === waitingFor(before) &&
    // A chat message is answered while the case waits for a goal.
    before.pendingMessageId === after.pendingMessageId
  );
}

/** What the case waits for a person to do; null if nothing right now. */
export function waitingFor(c: Case): WaitingFor {
  if (c.status !== "active" || c.failure) return null;
  if (!standingGoal(c)) return "goal";
  const selection = currentSelection(c);
  if (selection?.status === "proposed") return "pack";
  if (selection?.status !== "confirmed") return null;
  // A request for legal advice has no pack: only the referral to agree to.
  if (!selection.referral) {
    // Not yet: what the person said may already answer some of it.
    if (readingConversation(c)) return null;
    if (missing(c).length) return "answers";
    if (missingDocuments(c).length) return "answers";
    // All in: in review once the artifact matches them, until approved.
    const review = reviewOutcome(c);
    if (review !== "approved") return review === null ? "approval" : null;
  }
  return c.referral?.status === "offered" ? "consent" : null;
}
