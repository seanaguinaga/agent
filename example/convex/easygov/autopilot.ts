// Plays the person's part of a case, one step at a time. Pure: given the
// case as `getCase` returns it, it says what a person would send next. The
// answers are made up from the pinned pack, so it drives any pack, including
// one a model drafted.
import type { Infer } from "convex/values";
import { chosen, type CaseEvent, type WaitingFor } from "./case/schema";
import type { vCaseDoc } from "./schema";

// The types come from the schema, not the generated API: the eval runner is
// part of that API and uses this file.
export type { CaseEvent };
export type Waiting = WaitingFor;
/** A case as `getCase` returns it. */
export type CaseView = Infer<typeof vCaseDoc> & {
  waitingFor: WaitingFor;
  deadline: { label: string; date: string } | null;
  suggestions: Record<string, string>;
};
type Pack = NonNullable<NonNullable<ReturnType<typeof chosen>>["definition"]>;

export type PilotOptions = {
  /**
   * Where to hand the case back: once it waits for this, once it has been
   * approved, or ("end") never, so it runs until the case ends.
   */
  until: "pack" | "answers" | "approval" | "approved" | "consent" | "end";
  /** The goal to state if the case asks for one. Without it, stop there. */
  goal?: string;
  /** Answer the pack's referral check so that it passes, or so it doesn't. */
  referral: "trigger" | "avoid";
  consent: "share" | "decline";
};

export type PilotAction = { event: CaseEvent } | { upload: string };

const ANSWER_BOOK: Record<string, string> = {
  fullName: "Ada Lovelace",
  oldAddress: "1 Old Road, Oakland, CA",
  newAddress: "2 New Street, Berkeley, CA",
  employer: "Analytical Engines Ltd",
  reasonForAppeal: "The decision overlooked my medical records.",
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** The date `days` after a YYYY-MM-DD date. */
export function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/** An answer the case will take for `key`, steering the referral check. */
export function answerFor(
  pack: Pack,
  key: string,
  referral: PilotOptions["referral"],
  today: string,
): string {
  const when = pack.referral?.when;
  if (when?.input === key) {
    const pass = referral === "trigger";
    if ("equals" in when) return pass ? when.equals : `not ${when.equals}`;
    if ("atLeast" in when) return String(when.atLeast - (pass ? 0 : 1));
    return pass ? today : shiftDate(today, -(when.withinDays + 1));
  }
  if (pack.deadline?.fromInput === key) return shiftDate(today, -30);
  return ANSWER_BOOK[key] ?? `Test ${key}`;
}

/**
 * What to do next: an event to send, a file to upload, "wait" while the
 * workflow is busy, or "stop" when the case is handed back.
 */
export function pilot(
  c: CaseView,
  options: PilotOptions,
  today: string,
): PilotAction | "wait" | "stop" {
  if (c.status !== "active" || c.failure) return "stop";
  const { until } = options;
  if (until === "approved" ? c.approval !== undefined : c.waitingFor === until)
    return "stop";
  const selection = chosen(c.processPack);
  switch (c.waitingFor) {
    case null:
      return "wait";
    case "goal":
      return options.goal
        ? { event: { type: "intake.submit", goal: options.goal } }
        : "stop";
    case "pack":
      return { event: { type: "processPack.confirm" } };
    case "answers": {
      const pack = selection?.definition;
      if (!pack) return "stop";
      // What the case found in the conversation, a person would just accept.
      if (Object.keys(c.suggestions).length) {
        return { event: { type: "answers.accept" } };
      }
      const key = pack.inputs.find((input) => !c.answers[input]);
      if (key) {
        const value = answerFor(pack, key, options.referral, today);
        return { event: { type: "answers.set", key, value } };
      }
      const file = pack.documents?.find(
        (document) => document.required && !c.documents[document.key],
      );
      return file ? { upload: file.key } : "wait";
    }
    case "approval":
      return { event: { type: "review.approve" } };
    case "consent":
      if (options.consent === "decline")
        return { event: { type: "referral.decline" } };
      // A guest claims the case first; that's the person's call.
      return c.userId.startsWith("guest:")
        ? "stop"
        : { event: { type: "referral.share" } };
  }
}
