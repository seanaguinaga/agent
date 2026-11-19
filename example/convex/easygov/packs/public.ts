// What a landing page reads: the shared packs, one page each. No sign-in is
// needed, and nothing here is about a person.
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Doc } from "../../_generated/dataModel";
import { query } from "../../_generated/server";
import { currentVersion } from "./data";
import { vPackDocuments, vPackMatch, vProcessPackQuestions } from "./schema";

const vLanding = v.object({
  ...vPackMatch.fields,
  aliases: v.array(v.string()),
});

function landingOf(pack: Doc<"processPacks">) {
  const { _id, title, description, aliases, jurisdiction, authority, forms } =
    pack;
  return {
    id: _id,
    title,
    description,
    aliases,
    jurisdiction,
    authority,
    forms,
  };
}

/** The shared packs, a page at a time: one landing page for each. */
export const landings = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: v.object({
    page: v.array(vLanding),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, { paginationOpts }) => {
    const { page, isDone, continueCursor } = await ctx.db
      .query("processPacks")
      .withIndex("by_ownerId_and_status", (q) =>
        q.eq("ownerId", undefined).eq("status", "current"),
      )
      .paginate(paginationOpts);
    return { page: page.map(landingOf), isDone, continueCursor };
  },
});

/**
 * One landing page: what the process is, and what it will ask for. A link to
 * an older version shows the current one; pass its `id` to `startCase`.
 */
export const landing = query({
  args: { packId: v.id("processPacks") },
  returns: v.union(
    v.object({
      ...vLanding.fields,
      questions: vProcessPackQuestions,
      documents: vPackDocuments,
      deadline: v.optional(v.string()),
    }),
    v.null(),
  ),
  handler: async (ctx, { packId }) => {
    const pack = await currentVersion(ctx, packId);
    if (!pack) return null;
    return {
      ...landingOf(pack),
      questions:
        pack.inputQuestions ??
        pack.inputs.map((key) => ({ key, question: key })),
      documents: pack.documents ?? [],
      deadline: pack.deadline?.label,
    };
  },
});
