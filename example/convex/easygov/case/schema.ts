// Everything a case holds and every event a person can send it.
//
// Only validators here, and no `_generated` imports: the generated types are
// built from the schema, so they can't also be an input to it.
import { vWorkflowId } from "@convex-dev/workflow";
import { v, type Infer } from "convex/values";
import {
  vPackDeadline,
  vPackDocuments,
  vPackMatch,
  vPackReferral,
  vProcessPackDefinition,
  vProcessPackQuestions,
} from "../packs/schema";

export const caseFields = {
  /** The account, or `guest:<key>` for a case started without one. */
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

  processPack: v.optional(
    v.object({
      status: v.union(
        v.literal("proposed"),
        v.literal("confirmed"),
        v.literal("rejected"),
      ),
      /**
       * The `intake.version` this was made for. A selection for an earlier
       * goal counts as none. A rejected one for the current goal sends the
       * case back to intake for a new goal.
       */
      goalVersion: v.number(),
      /** The saved pack it pins, once there is one. */
      definition: v.optional(
        v.object({
          id: v.id("processPacks"),
          inputs: v.array(v.string()),
          inputQuestions: v.optional(vProcessPackQuestions),
          documents: v.optional(vPackDocuments),
          deadline: v.optional(vPackDeadline),
          referral: v.optional(vPackReferral),
        }),
      ),
      /** A new pack for the person to review; saved when they confirm. */
      draft: v.optional(vProcessPackDefinition),
      /** No pack: the request goes to a legal referral. */
      referral: v.optional(v.literal(true)),
      /** Where a referral with no pack applies, if the request said. */
      jurisdiction: v.optional(v.string()),
      /** Saved packs like the draft, for the person to reuse or set aside. */
      duplicateReview: v.optional(
        v.object({
          matches: v.array(vPackMatch),
          reviewedPackIds: v.array(v.id("processPacks")),
        }),
      ),
    }),
  ),

  /** The person's answers, by input key. */
  answers: v.record(v.string(), v.string()),
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
  v.object({
    type: v.literal("processPack.confirm"),
    reviewedPackIds: v.optional(v.array(v.id("processPacks"))),
  }),
  v.object({
    type: v.literal("processPack.useExisting"),
    packId: v.id("processPacks"),
  }),
  v.object({ type: v.literal("processPack.reject") }),
  // While collecting answers, or in review (which sends the case back).
  v.object({
    type: v.literal("answers.set"),
    key: v.string(),
    value: v.string(),
  }),
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
