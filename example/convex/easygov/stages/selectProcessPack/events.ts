// What a person can send about a proposal: confirm it, use a saved pack
// instead, or reject it.
import { ConvexError } from "convex/values";
import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import type { Case, Owned } from "../../case/data";
import type { StageEvents } from "../shared";
import { currentSelection, processPackDefinition, rejected } from "./data";

type Selection = Partial<Owned<"selectProcessPack">>;

export const events: StageEvents<"selectProcessPack"> = {
  "processPack.confirm": (found, { reviewedPackIds }, ctx) =>
    confirmProcessPack(ctx, found, reviewedPackIds),
  "processPack.useExisting": (found, { packId }, ctx) =>
    useExistingProcessPack(ctx, found, packId),
  "processPack.reject": (found) => {
    if (!found.intake) throw new ConvexError("The case has no goal yet.");
    if (currentSelection(found)?.status === "confirmed") {
      throw new ConvexError("The process pack has already been confirmed.");
    }
    return { processPack: rejected(found.intake.version) };
  },
};

/**
 * Confirms what was proposed. A draft is saved first, unless saved packs look
 * like it: those come back for review, and confirming again with their ids in
 * `reviewedPackIds` says the draft is different. The case's `seq` makes sure
 * the person confirms the proposal they saw.
 */
async function confirmProcessPack(
  ctx: MutationCtx,
  found: Case,
  reviewedPackIds?: Id<"processPacks">[],
): Promise<Selection> {
  const selection = currentSelection(found);
  if (selection?.status !== "proposed") {
    throw new ConvexError("There's no process pack proposal to confirm.");
  }
  const { draft, definition, referral, goalVersion } = selection;
  if (!draft) {
    if (reviewedPackIds || (!definition && !referral)) {
      throw new ConvexError("There's no draft to save.");
    }
    return {
      processPack: { status: "confirmed", goalVersion, definition, referral },
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
    ownerId: found.userId,
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
  const pack = await visiblePack(ctx, found, saved.id);
  return {
    processPack: {
      status: "confirmed",
      goalVersion,
      definition: processPackDefinition(pack),
    },
  };
}

/** Uses one of the saved packs shown for review instead of the draft. */
async function useExistingProcessPack(
  ctx: MutationCtx,
  found: Case,
  id: Id<"processPacks">,
): Promise<Selection> {
  const selection = currentSelection(found);
  if (
    selection?.status !== "proposed" ||
    !selection.duplicateReview?.matches.some((pack) => pack.id === id)
  ) {
    throw new ConvexError(
      "Choose one of the process packs shown for this draft.",
    );
  }
  const pack = await visiblePack(ctx, found, id);
  return {
    processPack: {
      status: "confirmed",
      goalVersion: selection.goalVersion,
      definition: processPackDefinition(pack),
    },
  };
}

async function visiblePack(
  ctx: MutationCtx,
  found: Case,
  id: Id<"processPacks">,
) {
  const pack = await ctx.db.get("processPacks", id);
  if (!pack || (pack.ownerId !== undefined && pack.ownerId !== found.userId)) {
    throw new ConvexError("Process pack not found.");
  }
  return pack;
}
