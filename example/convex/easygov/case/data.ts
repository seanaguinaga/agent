// The one way to write a case, and the types that say who may write what.
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { FIELDS, type Owner } from "./schema";

export type Case = Doc<"cases">;

/** The case fields `O` owns, as `schema.ts` lists them. */
export type Owned<O extends Owner> = Pick<
  Case,
  O extends Owner ? Extract<keyof (typeof FIELDS)[O], keyof Case> : never
>;

/**
 * The one way to change a case. `owner` says who is writing, "core" or a
 * stage, and may only write its own fields: the types say so, and a patch
 * that slips past them throws. Every write bumps `seq`, so a `send` based on
 * an older view of the case is refused.
 */
export async function writeCase<O extends Owner>(
  ctx: MutationCtx,
  owner: O,
  caseId: Id<"cases">,
  patch: Partial<Owned<O>>,
): Promise<void> {
  for (const key of Object.keys(patch)) {
    if (!Object.hasOwn(FIELDS[owner], key)) {
      throw new Error(`"${key}" isn't a case field ${owner} owns`);
    }
  }
  const found = await ctx.db.get("cases", caseId);
  if (!found) throw new Error(`No case ${caseId}`);
  const changes: Partial<Case> = patch;
  await ctx.db.patch("cases", caseId, { ...changes, seq: found.seq + 1 });
}

/** A stage that chats answered `messageId`. A newer message stays pending. */
export async function markAnswered(
  ctx: MutationCtx,
  found: Case,
  messageId: string,
): Promise<void> {
  if (found.pendingMessageId !== messageId) return;
  await writeCase(ctx, "core", found._id, { pendingMessageId: undefined });
}
