// What's kept about a person, apart from any one case.
import { defineTable } from "convex/server";
import { v } from "convex/values";
import { vFactValue } from "./vocabulary";

export default {
  /**
   * A fact about a person, as they gave it. Rows are never changed: a new
   * value is a new row, and the current one is the latest for its key. So a
   * finished case keeps what it was built from, and when a fact was last
   * confirmed is its row's creation time.
   */
  profileFacts: defineTable({
    userId: v.string(),
    /** A key of `FACTS` in `vocabulary.ts`. */
    key: v.string(),
    value: vFactValue,
  }).index("by_userId_and_key", ["userId", "key"]),

  /**
   * An answer that isn't a profile fact, kept with where it came from: the
   * pack that asked, in what words. The same pack offers it back next time;
   * another pack may suggest it for a similar question.
   */
  rememberedAnswers: defineTable({
    userId: v.string(),
    /** The saved pack that asked. A one-off draft has none. */
    packId: v.optional(v.id("processPacks")),
    key: v.string(),
    question: v.string(),
    value: v.string(),
    caseId: v.id("cases"),
  })
    .index("by_userId_and_packId_and_key", ["userId", "packId", "key"])
    // Kept beside the index above for its order: newest first across packs.
    // eslint-disable-next-line @convex-dev/no-duplicate-indexes
    .index("by_userId", ["userId"]),

  /**
   * A change to the profile that a finished case suggests, e.g. the new
   * address from a change-of-address form. `text` is what the person wrote
   * on the case; they confirm the fact's parts before it's saved.
   */
  profileProposals: defineTable({
    userId: v.string(),
    fact: v.string(),
    text: v.string(),
    source: v.optional(v.string()),
    caseId: v.id("cases"),
    status: v.union(
      v.literal("open"),
      v.literal("accepted"),
      v.literal("dismissed"),
    ),
  })
    .index("by_userId_and_status", ["userId", "status"])
    .index("by_caseId_and_fact_and_text", ["caseId", "fact", "text"]),
};
