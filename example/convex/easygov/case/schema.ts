// Everything a case can hold and every event it takes, in one place.
//
// Each field and each event has one owner: the pipeline ("core") or one stage.
// Only the owner writes a field (`writeCase` in `data.ts` enforces it), and
// only the owner handles an event. Any stage may read any field. `FIELDS` is
// keyed by owner; `EVENTS` is one row per event, naming its owner.
//
// Only validators here, and no `_generated` imports: the generated types are
// built from the schema, so they can't also be an input to it.
import { vWorkflowId } from "@convex-dev/workflow";
import {
  v,
  type Infer,
  type ObjectType,
  type PropertyValidators,
  type Validator,
  type VLiteral,
} from "convex/values";
import { vPlanStep } from "../plans/schema";
import {
  vPackMatch,
  vProcessPackDefinition,
  vProcessPackQuestions,
} from "../packs/schema";

// --- Fields, by owner -------------------------------------------------------

export const FIELDS = {
  /** What the pipeline and the public API own. */
  core: {
    userId: v.string(),
    /** The customer conversation. Every stage with an agent posts to it. */
    threadId: v.string(),
    /**
     * The newest user message no agent has answered yet. `sendMessage` sets
     * it; a stage that chats clears it with `markAnswered`.
     */
    pendingMessageId: v.optional(v.string()),
    /**
     * The `messageKey` of the last chat message saved, so the same message
     * sent twice (a double submit, a client retry) is saved once.
     */
    lastMessageKey: v.optional(v.string()),
    status: v.union(
      v.literal("active"),
      v.literal("done"),
      v.literal("stopped"),
      v.literal("canceled"),
    ),
    endReason: v.optional(v.string()),
    /** Bumped by every write to the case, so a stale `send` is refused. */
    seq: v.number(),
    /** The steps this case runs, in order. Stages can add to it. */
    plan: v.array(vPlanStep),
    /** The id of the step the case is at. Unset once the case has ended. */
    currentStep: v.optional(v.string()),
    /**
     * How many times each step has started, by step id. A stage workflow
     * reports back with its visit, so a callback from an older run is ignored.
     */
    visits: v.record(v.string(), v.number()),
    /**
     * Set while the current step's stage has failed and the case waits for a
     * retry or a giveUp. Running a step clears it.
     */
    failure: v.optional(v.object({ stepId: v.string(), error: v.string() })),
    /**
     * The stage workflow the case is running now: what `send` nudges and
     * cancel cancels. Unset while the step has failed, and at the end.
     */
    workflowId: v.optional(vWorkflowId),
    /** Plan conditions read these. No stage sets one yet. */
    flags: v.array(v.string()),
  },

  intake: {
    /**
     * What the person wants done, in one sentence. `version` goes up each
     * time a goal is set, even to the same words, so whatever was made for an
     * earlier goal (see `processPack.goalVersion`) is out of date on its own.
     */
    intake: v.optional(v.object({ goal: v.string(), version: v.number() })),
  },

  selectProcessPack: {
    processPack: v.optional(
      v.object({
        status: v.union(
          v.literal("proposed"),
          v.literal("confirmed"),
          v.literal("rejected"),
        ),
        /**
         * The `intake.version` this was made for. A selection for an earlier
         * goal counts as no selection. A rejected one for the current goal
         * makes intake wait for a new goal.
         */
        goalVersion: v.number(),
        /** The saved pack it pins, once there is one. */
        definition: v.optional(
          v.object({
            id: v.id("processPacks"),
            inputs: v.array(v.string()),
            inputQuestions: v.optional(vProcessPackQuestions),
          }),
        ),
        /** A new pack for the person to review; saved when they confirm. */
        draft: v.optional(vProcessPackDefinition),
        /** No pack: the request goes to a legal referral. */
        referral: v.optional(v.literal(true)),
        /** Saved packs like the draft, for the person to reuse or set aside. */
        duplicateReview: v.optional(
          v.object({
            matches: v.array(vPackMatch),
            reviewedPackIds: v.array(v.id("processPacks")),
          }),
        ),
      }),
    ),
  },

  collect: {
    /** The person's answers, by input key. */
    answers: v.record(v.string(), v.string()),
  },

  fill: {
    /** The filled-in document, and the fingerprint of the answers it used. */
    artifact: v.optional(
      v.object({ summary: v.string(), fingerprint: v.string() }),
    ),
  },

  review: {
    /** The fingerprint of the artifact the person approved. */
    approval: v.optional(v.object({ fingerprint: v.string() })),
  },

  deliver: {
    delivery: v.optional(
      v.object({ status: v.literal("prepared"), channel: v.string() }),
    ),
  },

  /** Keeps nothing on the case: it writes a row to `referrals`. */
  legalReferral: {},
};

/** "core" or a stage. */
export type Owner = keyof typeof FIELDS;
export type StageName = Exclude<Owner, "core">;

/** A case document's fields. A field listed under two owners fails a test. */
export const caseFields = {
  ...FIELDS.core,
  ...FIELDS.intake,
  ...FIELDS.selectProcessPack,
  ...FIELDS.collect,
  ...FIELDS.fill,
  ...FIELDS.review,
  ...FIELDS.deliver,
  ...FIELDS.legalReferral,
};

// --- Events -----------------------------------------------------------------

type EventRow = {
  /** Whose handler runs, and whose fields it writes. */
  owner: Owner;
  /** Other stages that take the event while they're the current step. */
  alsoDuring?: readonly StageName[];
  /** What the event carries, besides its `type`. */
  args: PropertyValidators;
};

/**
 * Everything a person can send to a case, one row per event.
 *
 * A stage's event is taken only while that stage is the current step (or one
 * listed in `alsoDuring`); the owner's file has the handler. A "core" event
 * belongs to the whole case, and the pipeline handles it (`CONTROL_INPUTS` in
 * `public.ts`): `case.cancel` at any time, the `step.*` pair after a failure.
 */
export const EVENTS = {
  "intake.submit": { owner: "intake", args: { goal: v.string() } },

  "processPack.confirm": {
    owner: "selectProcessPack",
    args: { reviewedPackIds: v.optional(v.array(v.id("processPacks"))) },
  },
  "processPack.useExisting": {
    owner: "selectProcessPack",
    args: { packId: v.id("processPacks") },
  },
  "processPack.reject": { owner: "selectProcessPack", args: {} },

  // Editing an answer during review runs collect's handler; review then
  // sends the case back.
  "answers.set": {
    owner: "collect",
    alsoDuring: ["review"],
    args: { key: v.string(), value: v.string() },
  },

  "review.approve": { owner: "review", args: {} },

  "step.retry": { owner: "core", args: {} },
  "step.cancel": { owner: "core", args: {} },
  "case.cancel": { owner: "core", args: {} },
} satisfies Record<string, EventRow>;

export type EventType = keyof typeof EVENTS;

/** The event of each type: its `type`, plus the row's `args`. */
type EventOf<Type extends EventType> =
  (typeof EVENTS)[Type]["args"] extends infer Args extends PropertyValidators
    ? ObjectType<{ type: VLiteral<Type, "required"> } & Args>
    : never;
export type CaseEvent = { [Type in EventType]: EventOf<Type> }[EventType];

/** The types of the events `O` owns. */
export type EventsOf<O extends Owner> = {
  [Type in EventType]: (typeof EVENTS)[Type]["owner"] extends O ? Type : never;
}[EventType];

/** One validator per row, e.g. `{ type: "intake.submit", goal: string }`. */
export const eventShapes = Object.entries(EVENTS).map(([type, row]) =>
  v.object({ type: v.literal(type), ...row.args }),
);

/** The validator for `CaseEvent`, built from the rows. */
export const vCaseEvent = v.union(...eventShapes) as unknown as Validator<
  CaseEvent,
  "required",
  string
>;

// --- What a stage returns ---------------------------------------------------

/** What a stage workflow returns. `decide` (`plans/decide.ts`) says what's next. */
export const vStageResult = v.union(
  v.object({
    outcome: v.literal("done"),
    /** Steps to insert after this one. `decide` validates them. */
    append: v.optional(v.array(vPlanStep)),
  }),
  /** Return to the step with this id. */
  v.object({ outcome: v.literal("back"), backTo: v.string() }),
  /** End the case. `reason` is shown as its `endReason`. */
  v.object({ outcome: v.literal("stop"), reason: v.string() }),
);
export type StageResult = Infer<typeof vStageResult>;
