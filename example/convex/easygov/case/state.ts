// What a case's fields mean. Pure: no ctx and no I/O, so these are tested
// with plain values. The workflow waits on them, and `send` checks them, so
// both always agree on where the case is.
import type { Doc } from "../../_generated/dataModel";
import { addDays } from "../dates";
import { isReading, READINGS } from "../profile/vocabulary";
import { fingerprint, missingInputs, passes } from "./answers";
import {
  chosen,
  definitionOf,
  WAITS,
  type Evidence,
  type Phase,
  type WaitingFor,
} from "./schema";

export type Case = Doc<"cases">;

/** The goal, unless the selection made for it was rejected. */
export function standingGoal(c: Case): string | undefined {
  const { goal, selection } = c;
  const rejected =
    selection?.status === "rejected" && selection.goalVersion === goal?.version;
  return rejected ? undefined : goal?.text;
}

/**
 * A newly stated goal. The version goes up even when the words are the same,
 * so a selection made (or rejected) for the goal before it is out of date.
 */
export function newGoal(c: Case, text: string): Case["goal"] {
  return { text, version: (c.goal?.version ?? 0) + 1 };
}

/** The selection made for the current goal. One for an earlier goal is none. */
export function currentSelection(c: Case) {
  const selection = c.selection;
  return selection?.goalVersion === c.goal?.version ? selection : undefined;
}

/** What was proposed or accepted for the current goal. A rejection is none. */
export function currentChoice(c: Case) {
  return chosen(currentSelection(c));
}

/** The input keys the accepted pack asks for. */
export function requiredInputs(c: Case): string[] | undefined {
  const selection = currentSelection(c);
  return selection?.status === "accepted"
    ? definitionOf(selection)?.inputs
    : undefined;
}

/** The accepted pack, as the case pinned it. */
export function pinnedPack(c: Case) {
  const selection = currentSelection(c);
  return selection?.status === "accepted" ? definitionOf(selection) : undefined;
}

/**
 * How the pack asks for `key`, in its own words. Without a question, a
 * profile reading is asked for by what it is, and anything else by its key.
 */
export function questionOf(c: Case, key: string): string {
  const asked = pinnedPack(c)?.inputQuestions?.find((q) => q.key === key);
  return asked?.question ?? (isReading(key) ? READINGS[key].label : key);
}

/** What was read from the conversation for the current goal, if started. */
function currentChatSuggestions(c: Case) {
  return c.chatSuggestions?.goalVersion === c.goal?.version
    ? c.chatSuggestions
    : undefined;
}

/** True while the conversation is being read for answers. */
export function isSuggesting(c: Case): boolean {
  const suggest = currentChatSuggestions(c);
  return !!suggest && suggest.answers === undefined;
}

/**
 * The suggested answers still on offer: for the current goal's questions,
 * and only where the person hasn't answered yet.
 */
export function suggestions(c: Case): Record<string, string> {
  // What the person said just now outranks what the profile remembers, and
  // what their own paperwork states outranks both.
  const found = {
    ...c.profileSuggestions,
    ...currentChatSuggestions(c)?.answers,
  };
  for (const { read } of caseEvidence(c)) {
    if (read.status === "read") Object.assign(found, read.answers);
  }
  return Object.fromEntries(
    missing(c)
      .filter((key) => found[key])
      .map((key) => [key, found[key]]),
  );
}

/** The accepted pack's inputs the case has no answer for yet. */
export function missing(c: Case): string[] {
  return missingInputs(requiredInputs(c) ?? [], c.answers, c.following);
}

/**
 * The files that are part of what the person accepts and shares: all but
 * the follow-ups, which arrive once the case is done.
 */
export function caseEvidence(c: Pick<Case, "evidence">): Evidence[] {
  return c.evidence.filter((file) => !file.followUp);
}

/** The keys of the required files the person hasn't attached yet. */
export function missingEvidence(c: Case): string[] {
  const attached = new Set(caseEvidence(c).map((file) => file.key));
  return (pinnedPack(c)?.evidence ?? [])
    .filter(({ key, required }) => required && !attached.has(key))
    .map(({ key }) => key);
}

/** The answers and files as they stand: what a document is built from. */
export function fingerprintOf(c: Case): string {
  return fingerprint(c.answers, caseEvidence(c));
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

/** "accepted", "changed" (an answer moved on since the artifact), or null. */
export function reviewOutcome(c: Case): "accepted" | "changed" | null {
  const current = fingerprintOf(c);
  if (c.artifact?.fingerprint !== current) return "changed";
  return c.accepted?.fingerprint === current ? "accepted" : null;
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

/** Where the case is, by name. Every case is in exactly one phase. */
export function phase(c: Case): Phase {
  if (c.status !== "active") return c.status;
  if (c.run?.state === "failed") return "failed";
  if (!standingGoal(c)) return "intake";
  const selection = currentSelection(c);
  if (!selection) return "proposing";
  if (selection.status === "proposed") return "pack";
  // A rejection for the current goal leaves no standing goal: not here.
  if (selection.status !== "accepted") return "intake";
  // A request for legal advice has no pack: only the referral to agree to.
  if (selection.kind !== "referral") {
    // Not yet: what the person said may already answer some of it.
    if (isSuggesting(c)) return "suggesting";
    if (missing(c).length || missingEvidence(c).length) return "answers";
    // All in: in review once the artifact matches them, until accepted.
    const review = reviewOutcome(c);
    if (review === "changed") return "filling";
    if (review === null) return "review";
  }
  return c.referral?.status === "offered" ? "consent" : "finishing";
}

/** What the case waits for a person to do; null if nothing right now. */
export function waitingFor(c: Case): WaitingFor {
  return WAITS[phase(c)] ?? null;
}
