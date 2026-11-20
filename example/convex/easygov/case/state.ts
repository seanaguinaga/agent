import { checkChoice } from "../forms/mapping";
// What a case's fields mean. Pure: no ctx and no I/O, so these are tested
// with plain values. The workflows are started from them and wait on them,
// and `sendEvent` checks them, so all agree on where the case is.
import type { Doc } from "../../_generated/dataModel";
import { addDays } from "../dates";
import { factOf, isReading, READINGS } from "../profile/vocabulary";
import { amountBand, type Stage } from "../firms/schema";
import { fingerprint, missingInputs, passes, signalsOf } from "./answers";
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
  const pack =
    selection?.status === "accepted" ? definitionOf(selection) : undefined;
  if (!pack) return undefined;
  return [
    ...new Set([
      ...pack.inputs,
      ...(pack.letterRoute && routeApplies(c, pack.letterRoute)
        ? pack.letterRoute.inputs
        : []),
      ...activeForms(c).flatMap((form) => form.inputs),
    ]),
  ];
}

export function routeApplies(c: Case, when?: { key: string; equals: string }) {
  return (
    !when ||
    c.answers[when.key]?.trim().toLowerCase() ===
      when.equals.trim().toLowerCase()
  );
}
export function activeForms(c: Case) {
  return (pinnedPack(c)?.packetForms ?? []).filter((form) =>
    routeApplies(c, form.when),
  );
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
export function conflictingSuggestions(c: Case): Record<string, string[]> {
  const candidates = [
    c.profileSuggestions,
    currentChatSuggestions(c)?.answers,
    ...caseEvidence(c).map((f) =>
      f.read.status === "read" ? f.read.answers : undefined,
    ),
  ];
  const conflicts: Record<string, string[]> = {};
  for (const key of missing(c)) {
    const values = [
      ...new Set(
        candidates.flatMap((source) =>
          source?.[key]?.trim() ? [source[key].trim()] : [],
        ),
      ),
    ];
    if (new Set(values.map((value) => value.toLowerCase())).size > 1)
      conflicts[key] = values;
  }
  return conflicts;
}
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
  const conflicts = conflictingSuggestions(c);
  return Object.fromEntries(
    missing(c)
      .filter((key) => found[key] && !conflicts[key])
      .flatMap((key) => {
        const question = pinnedPack(c)?.inputQuestions?.find(
          (q) => q.key === key,
        );
        const parsed = checkChoice(question ?? {}, found[key]);
        return "value" in parsed ? [[key, parsed.value]] : [];
      }),
  );
}

/**
 * What to ask for the accepted pack, in the pack's order, each with where
 * its answer stands. Empty until a pack is accepted.
 */
export function asks(c: Case) {
  const offered = suggestions(c);
  const conflicts = conflictingSuggestions(c);
  const following = new Set(c.following ?? []);
  const questions = pinnedPack(c)?.inputQuestions ?? [];
  return (requiredInputs(c) ?? []).map((key) => {
    const asked = questions.find((q) => q.key === key);
    return {
      key,
      question: questionOf(c, key),
      kind: answerKind(c, key),
      choices: asked?.choices,
      multiple: asked?.multiple,
      answer: c.answers[key],
      suggestion: offered[key],
      conflict: conflicts[key],
      fact: factOf(key),
      following: following.has(key),
    };
  });
}

/** The files the accepted pack asks for on this route, and how many are in. */
export function evidenceAsks(c: Case) {
  const files = caseEvidence(c);
  return (pinnedPack(c)?.evidence ?? [])
    .filter(({ when }) => routeApplies(c, when))
    .map(({ key, label, required }) => ({
      key,
      label,
      required,
      attached: files.filter((file) => file.key === key).length,
    }));
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
    .filter(
      ({ key, required, when }) =>
        required && routeApplies(c, when) && !attached.has(key),
    )
    .map(({ key }) => key);
}

/** The person can prepare a partial packet with exactly the answers they saw. */
export function readyToBuild(c: Case) {
  return (
    (!missing(c).length && !missingEvidence(c).length) ||
    (c.partialFingerprint !== undefined &&
      c.partialFingerprint === fingerprintOf(c))
  );
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
  const when = signalsOf(pack?.referral ?? {}).find(
    (signal) => signal.input === key && !("equals" in signal),
  );
  if (!when) return undefined;
  return "withinDays" in when ? "date" : "number";
}

/** The referral to offer for the pack, if its check passes on this day. */
export function packReferral(c: Case, on: string): string | undefined {
  const referral = pinnedPack(c)?.referral;
  if (!referral) return undefined;
  const signals = signalsOf(referral);
  return !signals.length ||
    signals.some((signal) => passes(signal, c.answers, on))
    ? referral.kind
    : undefined;
}

/** What the current choice asks for, accepted or still only proposed. */
function chosenDefinition(c: Case) {
  const choice = currentChoice(c);
  if (!choice || choice.kind === "referral") return undefined;
  return (
    choice.definition ?? (choice.kind === "draft" ? choice.draft : undefined)
  );
}

/** The kind of lawyer the case would go to, if the person asked for one now. */
export function referralKind(c: Case): string {
  return chosenDefinition(c)?.referral?.kind ?? "advice";
}

/** The amount at stake, in a band, if the pack's check reads one. */
export function amountBandOf(c: Case): string | undefined {
  const amount = signalsOf(chosenDefinition(c)?.referral ?? {}).find(
    (signal) => "atLeast" in signal,
  );
  const value = amount && c.answers[amount.input]?.trim();
  return value ? amountBand(Number(value)) : undefined;
}

/** How far the case has got, as a firm is told. */
export function stageOf(c: Case): Stage {
  if (c.status === "done") return "decision";
  const at = phase(c);
  if (at === "answers" || at === "review") return at;
  return at === "consent" || at === "finishing" ? "accepted" : "plan";
}

/** A referral that's with a firm, or waiting on the person's yes. */
function referralInHand(c: Case): boolean {
  return c.referral?.status === "shared" || c.referral?.status === "offered";
}

/**
 * Whether the person can ask for a lawyer now (`referral.request`), and
 * whether to suggest it: a decision against them has come in, or the
 * process is one lawyers take.
 */
export function lawyerDoor(c: Case): {
  available: boolean;
  reason?: "decision" | "contested";
} {
  const waits = waitingFor(c);
  const open =
    c.status === "done" ||
    waits === "pack" ||
    waits === "answers" ||
    waits === "review";
  if (!open || referralInHand(c)) return { available: false };
  const adverse = c.evidence.some(
    ({ read }) => read.status === "read" && read.adverse,
  );
  const contested =
    currentChoice(c)?.kind === "referral" ||
    chosenDefinition(c)?.referral !== undefined;
  return {
    available: true,
    reason: adverse ? "decision" : contested ? "contested" : undefined,
  };
}

/** A case started without an account. */
export function isGuest(c: Pick<Case, "userId">): boolean {
  return c.userId.startsWith("guest:");
}

/** "accepted", "changed" (an answer moved on since the artifact), or null. */
export function reviewOutcome(c: Case): "accepted" | "changed" | null {
  const current = fingerprintOf(c);
  if (c.reassess || c.artifact?.fingerprint !== current) return "changed";
  return c.accepted?.fingerprint === current ? "accepted" : null;
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
    if (!readyToBuild(c)) return "answers";
    // All in: in review once the artifact matches them, until accepted.
    const review = reviewOutcome(c);
    if (review === "changed") return "filling";
    if (review === null) return "review";
  }
  return c.referral?.status === "offered" ? "consent" : "finishing";
}

/**
 * Documents built without one being accepted before the case stops. A build
 * that comes out behind the answers starts another with no person involved,
 * so this one can run away.
 */
export const MAX_BUILDS = 20;

/**
 * True when the person asked to reassess a drafted process that hasn't been
 * revisited for it yet. One whose forms are all compiled has nothing to
 * revisit.
 */
export function needsRevisit(c: Case): boolean {
  const choice = currentChoice(c);
  if (!c.reassess || c.revised || choice?.kind !== "draft") return false;
  const forms = choice.draft.packetForms ?? [];
  return !(forms.length && forms.every((form) => form.blueprintId));
}

/** What to do for a case: a workflow to start, or the way to end it. */
export type Work =
  | { kind: "intake"; promptMessageId: string }
  | { kind: "propose" | "suggest" | "revise" | "build" | "finish" }
  | { kind: "stop"; reason: string };

/**
 * What to do for a case that has no work in hand. Null waits for the
 * person, who may take as many turns as they like: what their turns cost is
 * limited in `limits.ts`, not counted here.
 */
export function nextWork(c: Case): Work | null {
  if (c.status !== "active" || c.run) return null;
  switch (phase(c)) {
    case "intake":
      return c.pendingMessageId
        ? { kind: "intake", promptMessageId: c.pendingMessageId }
        : null;
    case "proposing":
      return { kind: "propose" };
    case "suggesting":
      return { kind: "suggest" };
    case "filling":
      if ((c.builds ?? 0) >= MAX_BUILDS)
        return {
          kind: "stop",
          reason: `Built ${MAX_BUILDS} times without acceptance`,
        };
      return { kind: needsRevisit(c) ? "revise" : "build" };
    case "finishing":
      return { kind: "finish" };
    // The person's turn (or the case is over).
    default:
      return null;
  }
}

/** What the case waits for a person to do; null if nothing right now. */
export function waitingFor(c: Case): WaitingFor {
  return WAITS[phase(c)] ?? null;
}
