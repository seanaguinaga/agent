// Everything a case holds and every event a person can send it.
//
// Only validators here, and no `_generated` imports: the generated types are
// built from the schema, so they can't also be an input to it.
import { vWorkflowId } from "@convex-dev/workflow";
import { v, type Infer } from "convex/values";
import { vFilledDocument } from "../forms/schema";
import {
  vPackDeadline,
  vPackDocuments,
  vPackProfileLinks,
  vPackReferral,
  vProcessPackDefinition,
  vProcessPackQuestions,
} from "../packs/schema";

/**
 * What reading a file found, by `status`. `reading` until the model has
 * looked. `read` holds what the file is and the facts it states, and the
 * answers it gives to the pack's questions, for the person to accept.
 * `unread` says why not: a kind of file we don't read, or a failed attempt.
 */
export const vFileRead = v.union(
  v.object({ status: v.literal("reading") }),
  v.object({
    status: v.literal("read"),
    summary: v.string(),
    answers: v.optional(v.record(v.string(), v.string())),
  }),
  v.object({ status: v.literal("unread"), reason: v.string() }),
);

/** A file the person attached to the case. */
export const vCaseFile = v.object({
  storageId: v.id("_storage"),
  /**
   * The pack's document this is, e.g. the denial letter. Without one it's
   * something else the person added. Several files can share a key: a
   * letter photographed page by page.
   */
  key: v.optional(v.string()),
  name: v.string(),
  mediaType: v.string(),
  size: v.number(),
  /**
   * Added once the case was done: the receipt, or what the authority sent
   * back. Not part of what was approved or shared.
   */
  followUp: v.optional(v.literal(true)),
  read: vFileRead,
});
export type CaseFile = Infer<typeof vCaseFile>;

/**
 * The `goal.version` a selection was made for. A selection for an earlier
 * goal counts as none. A rejected one for the current goal sends the case
 * back to intake for a new goal.
 */
const goalVersion = v.number();

/**
 * What the case asks for: pinned from the saved pack, or from the draft
 * once it's confirmed. Only a saved pack has an `id`.
 */
const vPinned = v.object({
  id: v.optional(v.id("processPacks")),
  inputs: v.array(v.string()),
  inputQuestions: v.optional(vProcessPackQuestions),
  documents: v.optional(vPackDocuments),
  deadline: v.optional(vPackDeadline),
  referral: v.optional(vPackReferral),
  profile: v.optional(vPackProfileLinks),
  form: v.optional(v.object({ editionId: v.id("formEditions") })),
});

/** What was chosen, by `kind`: one of three things, never a mix. */
const kinds = {
  /** A saved pack fits. */
  pack: { kind: v.literal("pack"), definition: vPinned },
  /**
   * A process drafted for this goal, when no saved pack fits. The case
   * runs on it once the person confirms (`definition` is pinned then), and
   * it stays here: it's never saved as a pack, so no other case finds it.
   */
  draft: {
    kind: v.literal("draft"),
    draft: vProcessPackDefinition,
    /**
     * What the search found about the process, when the draft was written
     * from it: where the checklist came from, and what an eval replays.
     */
    research: v.optional(v.string()),
    definition: v.optional(vPinned),
  },
  /** No pack: the request goes to a legal referral. */
  referral: {
    kind: v.literal("referral"),
    /** Where it applies, if the request said. */
    jurisdiction: v.optional(v.string()),
  },
};
const proposed = { status: v.literal("proposed"), goalVersion };
const confirmed = { status: v.literal("confirmed"), goalVersion };

export const vSelection = v.union(
  v.object({ ...proposed, ...kinds.pack }),
  v.object({ ...proposed, ...kinds.draft }),
  v.object({ ...proposed, ...kinds.referral }),
  v.object({ ...confirmed, ...kinds.pack }),
  v.object({ ...confirmed, ...kinds.draft }),
  v.object({ ...confirmed, ...kinds.referral }),
  v.object({
    status: v.literal("rejected"),
    goalVersion,
    /**
     * Who turned the goal down: the person rejected the proposal, or the
     * selection agent couldn't match the goal and asked a question instead.
     */
    reason: v.union(v.literal("person"), v.literal("clarification")),
  }),
);
export type Selection = Infer<typeof vSelection>;

/** The selection, if it chose something. A rejection chose nothing. */
export function chosen(selection: Selection | undefined) {
  return selection?.status === "rejected" ? undefined : selection;
}

/** What the selection pins for the case to run on. A referral pins nothing. */
export function definitionOf(selection: Selection | undefined) {
  const choice = chosen(selection);
  return choice && choice.kind !== "referral" ? choice.definition : undefined;
}

/** The selection's draft, if it chose one. */
export function draftOf(selection: Selection | undefined) {
  const choice = chosen(selection);
  return choice?.kind === "draft" ? choice.draft : undefined;
}

export const caseFields = {
  /** The account, or `guest:<SHA-256 of the key>` for a case started without one. */
  userId: v.string(),
  /** Where the case came from, e.g. the landing page that started it. */
  source: v.optional(v.string()),
  /** The customer conversation. The agents post to it. */
  threadId: v.string(),
  status: v.union(
    v.literal("active"),
    v.literal("done"),
    v.literal("stopped"),
    v.literal("canceled"),
  ),
  endReason: v.optional(v.string()),
  /** Bumped by every write to the case, so a stale `send` is refused. */
  seq: v.number(),
  /**
   * The case's workflow, by `state`: `running`, or `failed` while it waits
   * for a retry or a give-up. Unset once the case has ended.
   */
  run: v.optional(
    v.union(
      v.object({ state: v.literal("running"), workflowId: vWorkflowId }),
      v.object({
        state: v.literal("failed"),
        workflowId: vWorkflowId,
        error: v.string(),
      }),
    ),
  ),

  /**
   * The newest user message no agent has answered yet. `sendMessage` sets
   * it; intake clears it once it has replied, and so does confirming a
   * pack, after which there's no intake to answer it.
   */
  pendingMessageId: v.optional(v.string()),
  /**
   * The `messageKey` of the last chat message saved, so the same message
   * sent twice (a double submit, a client retry) is saved once.
   */
  lastMessageKey: v.optional(v.string()),

  /**
   * What the person wants done, in one sentence. `version` goes up each time
   * a goal is set, even to the same words, so a selection made for an earlier
   * goal (see `selection.goalVersion`) is out of date on its own.
   */
  goal: v.optional(v.object({ text: v.string(), version: v.number() })),

  /**
   * What was chosen for a goal, by `status` and `kind`. A rejection holds
   * only the goal it was for and who turned it down.
   */
  selection: v.optional(vSelection),

  /** The person's answers, by input key. */
  answers: v.record(v.string(), v.string()),
  /**
   * The answers that were read from the person's profile and still follow
   * it. An answer given on the case itself isn't listed, and stays as given.
   */
  following: v.optional(v.array(v.string())),
  /**
   * Answers offered from the profile for the person to accept, by input key:
   * a fact old enough to check ("still at this address?"), or what they
   * answered the last time this pack asked.
   */
  profileOffers: v.optional(v.record(v.string(), v.string())),
  /**
   * Answers found in what the person already said, for them to confirm.
   * They aren't answers until the person accepts them. `goalVersion` is the
   * goal whose questions they were read for; for an earlier goal they're
   * out of date. Without `answers` the conversation is still being read,
   * and the case isn't waiting for the person yet.
   *
   * Set when a proposal is confirmed. A case started on a landing page has
   * said nothing, so it has none.
   */
  prefill: v.optional(
    v.object({
      goalVersion: v.number(),
      answers: v.optional(v.record(v.string(), v.string())),
    }),
  ),
  /** The files the person attached, in the order they came. */
  files: v.array(vCaseFile),
  /**
   * The filled-in document, and the fingerprint of the answers and files it
   * used. `letter` is set when the pack writes one.
   */
  artifact: v.optional(
    v.object({
      summary: v.string(),
      letter: v.optional(v.string()),
      /**
       * The checklist steps that apply to this person, when the pack tailors
       * them by their answers. Always some of the pack's own steps, in the
       * pack's order: tailoring leaves steps out, it never writes any.
       */
      checklist: v.optional(v.array(v.string())),
      /**
       * The official form, filled in, when the pack fills one. `omissions`
       * are values that weren't written and why. `toComplete` is what's
       * left for the person: their signature, or something confidential
       * we don't hold.
       */
      document: v.optional(vFilledDocument),
      fingerprint: v.string(),
    }),
  ),
  /** The fingerprint of the artifact the person approved. */
  approval: v.optional(v.object({ fingerprint: v.string() })),
  /**
   * A legal referral offered to the person, and what they said. Nothing is
   * shared while it's only `offered`. `withdrawn` is a shared one the person
   * took back before a firm accepted it.
   */
  referral: v.optional(
    v.object({
      kind: v.string(),
      status: v.union(
        v.literal("offered"),
        v.literal("shared"),
        v.literal("declined"),
        v.literal("withdrawn"),
      ),
    }),
  ),
  delivery: v.optional(
    v.object({ status: v.literal("prepared"), channel: v.string() }),
  ),
};

/**
 * What the case waits for a person to do, worked out from its fields
 * (`waitingFor` in `state.ts`). Null while the workflow is busy, after a
 * failure, and once the case has ended.
 */
export const vWaitingFor = v.union(
  v.literal("goal"),
  v.literal("pack"),
  v.literal("answers"),
  v.literal("approval"),
  v.literal("consent"),
  v.null(),
);
export type WaitingFor = Infer<typeof vWaitingFor>;

/**
 * Where a case is, by name, worked out from its fields (`phase` in
 * `state.ts`): every situation has one, so nothing hides behind a null.
 * In order, though a case can go back: a rejected pack returns to `intake`,
 * and an answer changed in review returns to `filling`.
 */
export const PHASES = [
  // The person says what they want; intake answers their chat.
  "intake",
  // The workflow looks for a process that fits the goal.
  "proposing",
  // The person confirms the proposed process, or rejects it.
  "pack",
  // The workflow reads the conversation for answers already given.
  "reading",
  // The person gives the answers and files the process asks for.
  "answers",
  // The workflow builds the document from the answers.
  "filling",
  // The person reviews the document and approves it.
  "approval",
  // The person says whether to share the case with a lawyer.
  "consent",
  // The workflow prepares delivery and ends the case.
  "finishing",
  // The workflow failed, and waits for a retry or a give-up.
  "failed",
  // Ended: the case's `status`.
  "done",
  "stopped",
  "canceled",
] as const;
export type Phase = (typeof PHASES)[number];
export const vPhase = v.union(
  v.literal("intake"),
  v.literal("proposing"),
  v.literal("pack"),
  v.literal("reading"),
  v.literal("answers"),
  v.literal("filling"),
  v.literal("approval"),
  v.literal("consent"),
  v.literal("finishing"),
  v.literal("failed"),
  v.literal("done"),
  v.literal("stopped"),
  v.literal("canceled"),
);

/** What the person is asked for in each phase that waits for them. */
export const WAITS: Partial<Record<Phase, NonNullable<WaitingFor>>> = {
  intake: "goal",
  pack: "pack",
  answers: "answers",
  approval: "approval",
  consent: "consent",
};

/**
 * What can be recorded in a case's history (`caseEvents.kind`). These are
 * what happened, not what was sent: see `vCaseEvent` for the latter.
 */
export const vHistoryKind = v.union(
  v.literal("case.started"),
  v.literal("case.claimed"),
  v.literal("case.failed"),
  v.literal("case.retried"),
  v.literal("case.done"),
  v.literal("case.stopped"),
  v.literal("case.canceled"),
  v.literal("goal.set"),
  v.literal("pack.proposed"),
  v.literal("pack.clarification"),
  v.literal("answers.suggested"),
  v.literal("file.attached"),
  v.literal("file.removed"),
  v.literal("document.filled"),
  v.literal("referral.shared"),
  v.literal("referral.accepted"),
  v.literal("referral.withdrawn"),
);
export type HistoryKind = Infer<typeof vHistoryKind>;

/** Everything a person can send to a case. */
export const vCaseEvent = v.union(
  // While waiting for a goal: state it without chatting.
  v.object({ type: v.literal("goal.set"), goal: v.string() }),
  // While waiting on a proposed pack.
  v.object({ type: v.literal("processPack.confirm") }),
  v.object({ type: v.literal("processPack.reject") }),
  // While collecting answers, or in review (which sends the case back).
  v.object({
    type: v.literal("answers.set"),
    key: v.string(),
    value: v.string(),
    /** Keep it to this case: don't save it for other forms. */
    caseOnly: v.optional(v.boolean()),
  }),
  // With the answers: take every suggested answer that's still unanswered.
  v.object({ type: v.literal("answers.accept") }),
  // Until the document is approved: attach an uploaded file. With a `key`
  // it's one the pack asks for; without, anything else that helps. Once the
  // case is done, it adds what came afterwards (a follow-up, with no key).
  v.object({
    type: v.literal("document.attach"),
    storageId: v.id("_storage"),
    key: v.optional(v.string()),
    /** The file's name, as the person knows it. */
    name: v.optional(v.string()),
  }),
  // Says which of the pack's documents an attached file is, or none.
  v.object({
    type: v.literal("document.label"),
    storageId: v.id("_storage"),
    key: v.optional(v.string()),
  }),
  // Takes an attached file off the case.
  v.object({ type: v.literal("document.remove"), storageId: v.id("_storage") }),
  // In review.
  v.object({ type: v.literal("review.approve") }),
  // When a referral is offered: share the case with a lawyer, or don't.
  v.object({ type: v.literal("referral.share") }),
  v.object({ type: v.literal("referral.decline") }),
  // After a failure: run again, or stop.
  v.object({ type: v.literal("step.retry") }),
  v.object({ type: v.literal("step.cancel") }),
  // At any time.
  v.object({ type: v.literal("case.cancel") }),
);
export type CaseEvent = Infer<typeof vCaseEvent>;
