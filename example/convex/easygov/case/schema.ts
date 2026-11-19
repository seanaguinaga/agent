// Everything a case holds and every event a person can send it.
//
// Only validators here, and no `_generated` imports: the generated types are
// built from the schema, so they can't also be an input to it.
import { vWorkflowId } from "@convex-dev/workflow";
import { v, type Infer } from "convex/values";
import { vLeft } from "../forms/schema";
import {
  vPackDeadline,
  vPackDocuments,
  vPackProfileLinks,
  vPackReferral,
  vProcessPackDefinition,
  vProcessPackQuestions,
} from "../packs/schema";

/** An official form, filled in for a case. */
export const vFilledDocument = v.object({
  storageId: v.id("_storage"),
  omissions: v.array(v.object({ label: v.string(), reason: v.string() })),
  toComplete: v.array(vLeft),
});

/**
 * The `intake.version` a selection was made for. A selection for an earlier
 * goal counts as none. A rejected one for the current goal sends the case
 * back to intake for a new goal.
 */
const goalVersion = v.number();

/** What a proposed or confirmed selection holds. */
const selectionFields = {
  goalVersion,
  /**
   * What the case asks for: pinned from the saved pack, or from the
   * draft once it's confirmed. Only a saved pack has an `id`.
   */
  definition: v.optional(
    v.object({
      id: v.optional(v.id("processPacks")),
      inputs: v.array(v.string()),
      inputQuestions: v.optional(vProcessPackQuestions),
      documents: v.optional(vPackDocuments),
      deadline: v.optional(vPackDeadline),
      referral: v.optional(vPackReferral),
      profile: v.optional(vPackProfileLinks),
      form: v.optional(v.object({ editionId: v.id("formEditions") })),
    }),
  ),
  /**
   * A process drafted for this goal, when no saved pack fits. The case
   * runs on it once the person confirms, and it stays here: it's never
   * saved as a pack, so no other case finds it.
   */
  draft: v.optional(vProcessPackDefinition),
  /**
   * What the search found about the process, when the draft was written
   * from it: where the checklist came from, and what an eval replays.
   */
  research: v.optional(v.string()),
  /** No pack: the request goes to a legal referral. */
  referral: v.optional(v.literal(true)),
  /** Where a referral with no pack applies, if the request said. */
  jurisdiction: v.optional(v.string()),
};

export const vSelection = v.union(
  v.object({ status: v.literal("proposed"), ...selectionFields }),
  v.object({ status: v.literal("confirmed"), ...selectionFields }),
  v.object({ status: v.literal("rejected"), goalVersion }),
);
export type Selection = Infer<typeof vSelection>;

/** The selection, if it chose something. A rejection chose nothing. */
export function chosen(selection: Selection | undefined) {
  return selection?.status === "rejected" ? undefined : selection;
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
  /** The case's workflow while it runs. Unset once it has failed or ended. */
  workflowId: v.optional(vWorkflowId),
  /** Set while the workflow has failed and waits for a retry or a give-up. */
  failure: v.optional(v.object({ error: v.string(), workflowId: vWorkflowId })),

  /**
   * The newest user message no agent has answered yet. `sendMessage` sets
   * it; intake clears it once it has replied.
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
   * goal (see `processPack.goalVersion`) is out of date on its own.
   */
  intake: v.optional(v.object({ goal: v.string(), version: v.number() })),

  /**
   * What was chosen for a goal, by `status`. A rejection holds nothing but
   * the goal it was for.
   */
  processPack: v.optional(vSelection),

  /** The person's answers, by input key. */
  answers: v.record(v.string(), v.string()),
  /**
   * The answers that were read from the person's profile and still follow
   * it. An answer given on the case itself isn't listed, and stays as given.
   */
  fromProfile: v.optional(v.array(v.string())),
  /**
   * Answers offered from the profile for the person to accept, by input key:
   * a fact old enough to check ("still at this address?"), or what they
   * answered the last time this pack asked.
   */
  offers: v.optional(v.record(v.string(), v.string())),
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
  suggested: v.optional(
    v.object({
      goalVersion: v.number(),
      answers: v.optional(v.record(v.string(), v.string())),
    }),
  ),
  /** The files the person attached, by document key. */
  documents: v.record(v.string(), v.id("_storage")),
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
   * shared while it's only `offered`.
   */
  referral: v.optional(
    v.object({
      kind: v.string(),
      status: v.union(
        v.literal("offered"),
        v.literal("shared"),
        v.literal("declined"),
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

/** Everything a person can send to a case. */
export const vCaseEvent = v.union(
  // While waiting for a goal: state it without chatting.
  v.object({ type: v.literal("intake.submit"), goal: v.string() }),
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
  // With the answers: attach a file the pack asks for.
  v.object({
    type: v.literal("document.attach"),
    key: v.string(),
    storageId: v.id("_storage"),
  }),
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
