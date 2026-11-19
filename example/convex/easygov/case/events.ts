// What a person can send to a case, besides chat messages. Each event is
// taken only while the case waits for it (`waitingFor` in `state.ts`), and
// its handler returns what to write. The workflow then looks again.
import { ConvexError } from "convex/values";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { DEFAULT_PRICE_CENTS } from "../firms/schema";
import { answerProblem, today } from "./answers";
import { logCaseEvent, processPackDefinition } from "./data";
import type { CaseEvent, WaitingFor } from "./schema";
import {
  answerKind,
  currentSelection,
  deadlineOf,
  fingerprintOf,
  isGuest,
  newGoal,
  packReferral,
  pinnedPack,
  requiredInputs,
  type Case,
} from "./state";

type PersonEvent = Exclude<
  CaseEvent,
  { type: "step.retry" | "step.cancel" | "case.cancel" }
>;
type Handler<T extends PersonEvent["type"]> = (
  ctx: MutationCtx,
  c: Case,
  event: Extract<PersonEvent, { type: T }>,
) => Partial<Case> | Promise<Partial<Case>>;

/** When each event is taken, and what it writes. */
export const EVENTS: {
  [T in PersonEvent["type"]]: { during: WaitingFor[]; handle: Handler<T> };
} = {
  "intake.submit": {
    during: ["goal"],
    handle: (_ctx, c, { goal }) => {
      const text = goal.trim();
      if (!text) throw new ConvexError("Say what you want to get done.");
      return { intake: newGoal(c, text) };
    },
  },
  "processPack.confirm": {
    during: ["pack"],
    handle: (ctx, c, { reviewedPackIds }) => confirm(ctx, c, reviewedPackIds),
  },
  "processPack.useExisting": {
    during: ["pack"],
    handle: (ctx, c, { packId }) => useExisting(ctx, c, packId),
  },
  "processPack.reject": {
    during: ["pack"],
    handle: (_ctx, c) => ({
      processPack: { status: "rejected", goalVersion: c.intake!.version },
    }),
  },
  // In review too: the changed answer sends the case back around.
  "answers.set": {
    during: ["answers", "approval"],
    handle: (_ctx, c, { key, value }) => {
      if (!requiredInputs(c)?.includes(key)) {
        throw new ConvexError(`"${key}" isn't one of this case's inputs.`);
      }
      const problem = answerProblem(value, answerKind(c, key));
      if (problem) throw new ConvexError(problem);
      return { answers: { ...c.answers, [key]: value } };
    },
  },
  // In review too, like an answer.
  "document.attach": {
    during: ["answers", "approval"],
    handle: async (ctx, c, { key, storageId }) => {
      if (!pinnedPack(c)?.documents?.some((document) => document.key === key)) {
        throw new ConvexError(`"${key}" isn't one of this case's documents.`);
      }
      if (!(await ctx.db.system.get("_storage", storageId))) {
        throw new ConvexError("Upload the file first.");
      }
      return { documents: { ...c.documents, [key]: storageId } };
    },
  },
  // Approving also settles whether a referral is offered: the pack's check
  // is read once, today, so the offer doesn't come and go with the date.
  "review.approve": {
    during: ["approval"],
    handle: (_ctx, c) => {
      const kind = packReferral(c, today(Date.now()));
      return {
        approval: { fingerprint: fingerprintOf(c) },
        referral: kind ? { kind, status: "offered" } : undefined,
      };
    },
  },
  "referral.share": {
    during: ["consent"],
    handle: (ctx, c) => share(ctx, c),
  },
  "referral.decline": {
    during: ["consent"],
    handle: (_ctx, c) => ({
      referral: { kind: c.referral!.kind, status: "declined" },
    }),
  },
};

/**
 * Shares the case with a lawyer: copies what the person approved into
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
  const pack = pinned && (await ctx.db.get("processPacks", pinned.id));
  await ctx.db.insert("referrals", {
    caseId: c._id,
    userId: c.userId,
    kind,
    status: "open",
    jurisdiction: pack?.jurisdiction ?? currentSelection(c)?.jurisdiction,
    priceCents: pinned?.referral?.priceCents ?? DEFAULT_PRICE_CENTS,
    source: c.source,
    goal: c.intake!.goal,
    packId: pinned?.id,
    answers: c.answers,
    documents: c.documents,
    deadline: deadlineOf(c)?.date,
    fingerprint: fingerprintOf(c),
  });
  await logCaseEvent(ctx, c._id, "referral.shared", kind);
  return { referral: { kind, status: "shared" } };
}

/**
 * Confirms what was proposed. A draft is saved first, unless saved packs look
 * like it: those come back for review, and confirming again with their ids in
 * `reviewedPackIds` says the draft is different. The case's `seq` makes sure
 * the person confirms the proposal they saw.
 */
async function confirm(
  ctx: MutationCtx,
  c: Case,
  reviewedPackIds?: Id<"processPacks">[],
): Promise<Partial<Case>> {
  const selection = currentSelection(c)!;
  const { draft, definition, referral, jurisdiction, goalVersion } = selection;
  if (!draft) {
    if (reviewedPackIds) throw new ConvexError("There's no draft to save.");
    return {
      processPack: {
        status: "confirmed",
        goalVersion,
        definition,
        referral,
        jurisdiction,
      },
      // Legal advice has no pack: the referral is all there is to agree to.
      referral: referral ? { kind: "advice", status: "offered" } : undefined,
    };
  }

  const review = selection.duplicateReview;
  let reviewed = review?.reviewedPackIds ?? [];
  if (reviewedPackIds) {
    if (
      !review ||
      reviewedPackIds.length !== review.matches.length ||
      review.matches.some(({ id }) => !reviewedPackIds.includes(id))
    ) {
      throw new ConvexError(
        "Review the current possible matches before saving.",
      );
    }
    reviewed = [...reviewed, ...reviewedPackIds];
  }

  // The save shares this mutation's transaction, so it lands with the case.
  const saved = await ctx.runMutation(internal.easygov.packs.data.save, {
    ownerId: c.userId,
    ...draft,
    reviewedPackIds: reviewed,
  });
  if (saved.kind === "reviewDuplicates") {
    return {
      processPack: {
        ...selection,
        duplicateReview: { matches: saved.packs, reviewedPackIds: reviewed },
      },
    };
  }
  const pack = await visiblePack(ctx, c, saved.id);
  return {
    processPack: {
      status: "confirmed",
      goalVersion,
      definition: processPackDefinition(pack),
    },
  };
}

/** Uses one of the saved packs shown for review instead of the draft. */
async function useExisting(
  ctx: MutationCtx,
  c: Case,
  id: Id<"processPacks">,
): Promise<Partial<Case>> {
  const selection = currentSelection(c)!;
  if (!selection.duplicateReview?.matches.some((pack) => pack.id === id)) {
    throw new ConvexError(
      "Choose one of the process packs shown for this draft.",
    );
  }
  const pack = await visiblePack(ctx, c, id);
  return {
    processPack: {
      status: "confirmed",
      goalVersion: selection.goalVersion,
      definition: processPackDefinition(pack),
    },
  };
}

async function visiblePack(ctx: MutationCtx, c: Case, id: Id<"processPacks">) {
  const pack = await ctx.db.get("processPacks", id);
  if (!pack || (pack.ownerId !== undefined && pack.ownerId !== c.userId)) {
    throw new ConvexError("Process pack not found.");
  }
  return pack;
}
