// What a person can send to a case, besides chat messages. Each event is
// taken only while the case waits for it (`waitingFor` in `state.ts`), and
// its handler returns what to write. The workflow then looks again.
import { ConvexError } from "convex/values";
import type { MutationCtx } from "../../_generated/server";
import { DEFAULT_PRICE_CENTS } from "../firms/schema";
import { checkChoice } from "../forms/mapping";
import { currentFacts, keepAnswer } from "../profile/data";
import { factOf, READINGS, type FactKey } from "../profile/vocabulary";
import { today } from "../dates";
import { answerProblem } from "./answers";
import { draftDefinition, logCaseEvent } from "./data";
import { add, update, remove } from "./evidence";
import {
  definitionOf,
  draftOf,
  type CaseEvent,
  type Selection,
  type WaitingFor,
} from "./schema";
import {
  answerKind,
  caseEvidence,
  currentChoice,
  deadlineOf,
  fingerprintOf,
  isGuest,
  newGoal,
  packReferral,
  pinnedPack,
  requiredInputs,
  suggestions,
  waitingFor,
  type Case,
} from "./state";

export type PersonEvent = Exclude<
  CaseEvent,
  { type: "case.retry" | "case.stop" | "case.cancel" }
>;
type Handler<T extends PersonEvent["type"]> = (
  ctx: MutationCtx,
  c: Case,
  event: Extract<PersonEvent, { type: T }>,
) => Partial<Case> | Promise<Partial<Case>>;

/** When each event is taken, and what it writes. */
const EVENTS: {
  [T in PersonEvent["type"]]: { during: WaitingFor[]; handle: Handler<T> };
} = {
  "goal.set": {
    during: ["goal"],
    handle: async (ctx, c, { goal }) => {
      const text = goal.trim();
      if (!text) throw new ConvexError("Say what you want to get done.");
      await logCaseEvent(ctx, c._id, "goal.set", text);
      return { goal: newGoal(c, text) };
    },
  },
  "pack.accept": {
    during: ["pack"],
    handle: (_ctx, c) => accept(c),
  },
  "pack.reject": {
    during: ["pack"],
    handle: (_ctx, c) => ({
      selection: {
        status: "rejected",
        goalVersion: c.goal!.version,
        reason: "person",
      },
    }),
  },
  // In review too: the changed answer sends the case back around.
  "answers.set": {
    during: ["answers", "review"],
    handle: async (ctx, c, { key, value: given, caseOnly }) => {
      if (!requiredInputs(c)?.includes(key)) {
        throw new ConvexError(`"${key}" isn't one of this case's inputs.`);
      }
      const problem = answerProblem(given, answerKind(c, key));
      if (problem) throw new ConvexError(problem);
      // A set of tick boxes takes one of its choices, or several.
      const asked = pinnedPack(c)?.inputQuestions?.find((q) => q.key === key);
      const checked = checkChoice(asked ?? {}, given);
      if ("problem" in checked) throw new ConvexError(checked.problem);
      const { value } = checked;
      // An answer is the person's before it's the form's: it's kept for
      // their next form, unless they say it's only for this one.
      const followsProfile =
        !caseOnly && (await keepAnswer(ctx, c, key, value));
      const following = (c.following ?? []).filter((other) => other !== key);
      return {
        answers: { ...c.answers, [key]: value },
        following: followsProfile ? [...following, key] : following,
      };
    },
  },
  // Takes what was offered, where nothing was answered: what was found in
  // the conversation, and what the profile remembers.
  "answers.accept": {
    during: ["answers", "review"],
    handle: async (ctx, c) => {
      const offered = suggestions(c);
      if (!Object.keys(offered).length) {
        throw new ConvexError("There's nothing suggested to accept.");
      }
      const following = new Set(c.following ?? []);
      const { facts } = await currentFacts(ctx, c.userId);
      const confirmed = new Set<FactKey>();
      for (const [key, value] of Object.entries(offered)) {
        const fact = factOf(key);
        // The profile's own value, offered back because it's old: saying
        // yes confirms the fact as it stands, and the case follows it.
        if (fact && READINGS[key].read(facts) === value) {
          confirmed.add(fact);
          following.add(key);
        } else if (await keepAnswer(ctx, c, key, value)) {
          following.add(key);
        }
      }
      for (const fact of confirmed) {
        await ctx.db.insert("profileFacts", {
          userId: c.userId,
          key: fact,
          value: facts[fact]!,
        });
      }
      return {
        answers: { ...c.answers, ...offered },
        following: [...following].sort(),
      };
    },
  },
  // From the first message until the document is accepted: the letter can
  // start the case. In review a new file sends the case back around, like
  // an answer.
  "evidence.add": {
    during: ["goal", "pack", "answers", "review"],
    handle: (ctx, c, event) => add(ctx, c, event),
  },
  "evidence.update": {
    during: ["answers", "review"],
    handle: (_ctx, c, { storageId, key }) => update(c, storageId, key),
  },
  "evidence.remove": {
    during: ["goal", "pack", "answers", "review"],
    handle: (ctx, c, { storageId }) =>
      remove(ctx, c, storageId, { followUp: false }),
  },
  // Accepting also settles whether a referral is offered: the pack's check
  // is read once, today, so the offer doesn't come and go with the date.
  "artifact.accept": {
    during: ["review"],
    handle: (_ctx, c) => {
      const kind = packReferral(c, today(Date.now()));
      return {
        accepted: { fingerprint: fingerprintOf(c) },
        referral: kind ? { kind, status: "offered" } : undefined,
      };
    },
  },
  "referral.share": {
    during: ["consent"],
    handle: (ctx, c) => share(ctx, c),
  },
  "referral.reject": {
    during: ["consent"],
    handle: (_ctx, c) => ({
      referral: { kind: c.referral!.kind, status: "rejected" },
    }),
  },
};

/**
 * What a person's event writes to the case. Refused unless the case waits
 * for it. A lookup in the table loses which handler goes with which event,
 * so the one cast that restores it is here.
 */
export async function take(
  ctx: MutationCtx,
  c: Case,
  event: PersonEvent,
): Promise<Partial<Case>> {
  const { during, handle } = EVENTS[event.type] as {
    during: WaitingFor[];
    handle: Handler<PersonEvent["type"]>;
  };
  if (!during.includes(waitingFor(c))) {
    throw new ConvexError(`"${event.type}" isn't expected right now.`);
  }
  return await handle(ctx, c, event);
}

/**
 * Shares the case with a lawyer: copies what the person accepted into
 * `referrals`, as it is now, for one firm that covers it to accept. The
 * case's `seq` makes sure they agree to the case they saw. A guest has no account for a lawyer to reach, so they
 * claim the case first.
 */
async function share(ctx: MutationCtx, c: Case): Promise<Partial<Case>> {
  if (isGuest(c)) {
    throw new ConvexError("Create an account before sharing your case.");
  }
  const { kind } = c.referral!;
  const pinned = pinnedPack(c);
  const selection = currentChoice(c);
  const pack = pinned?.id && (await ctx.db.get("processPacks", pinned.id));
  await ctx.db.insert("referrals", {
    caseId: c._id,
    userId: c.userId,
    kind,
    status: "open",
    jurisdiction:
      (pack || draftOf(selection))?.jurisdiction ??
      (selection?.kind === "referral" ? selection.jurisdiction : undefined),
    priceCents: pinned?.referral?.priceCents ?? DEFAULT_PRICE_CENTS,
    source: c.source,
    goal: c.goal!.text,
    packId: pinned?.id,
    answers: c.answers,
    evidence: caseEvidence(c).map(({ read, ...file }) => ({
      ...file,
      ...(read.status === "read" && { summary: read.summary }),
    })),
    deadline: deadlineOf(c)?.date,
    fingerprint: fingerprintOf(c),
  });
  await logCaseEvent(ctx, c._id, "referral.shared", kind);
  return { referral: { kind, status: "shared" } };
}

/**
 * Accepts what was proposed: a saved pack, a draft, or a legal referral.
 * A draft isn't saved as a pack. The case runs on it as it is, and it stays
 * on the case. The case's `seq` makes sure the person accepts the proposal
 * they saw.
 */
function accept(c: Case): Partial<Case> {
  const proposed = currentChoice(c)!;
  const { goalVersion } = proposed;
  const selection: Selection =
    proposed.kind === "draft"
      ? {
          ...proposed,
          status: "accepted",
          definition: draftDefinition(proposed.draft),
        }
      : { ...proposed, status: "accepted" };
  const referral = proposed.kind === "referral";
  return {
    selection,
    // Intake is over: a message it never answered isn't pending any more.
    // It's still in the conversation, which is read for answers next.
    pendingMessageId: undefined,
    // A proposal follows a stated goal, so there's a conversation to read
    // for answers before asking for them.
    chatSuggestions: definitionOf(selection)?.inputs.length
      ? { goalVersion }
      : undefined,
    // Legal advice has no pack: the referral is all there is to agree to.
    referral: referral ? { kind: "advice", status: "offered" } : undefined,
  };
}
