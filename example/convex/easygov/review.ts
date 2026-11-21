// What went wrong lately, to decide what to improve:
//
//   npx convex run easygov/review:lastDays '{"days":7}'
//
// Two halves, joined by the case's thread. What people corrected, from the
// case history: a rejected proposal, an answer changed from what a model
// read or changed in review, a document sent back to reassess. And what each
// agent step cost and how often it failed, from its spans (see
// `debugging/spans.ts`). Read the example threads before changing a prompt,
// then turn a real failure into an eval case (see `evals/`).
import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalQuery } from "../_generated/server";
import { DAY, summarizeSpans, vSpanSummary } from "../debugging/spans";
import type { HistoryKind } from "./case/schema";

/** What a person does when a model got something wrong, and failures. */
const CORRECTIONS = [
  "pack.rejected",
  "pack.clarification",
  "answer.changed",
  "artifact.reassessed",
  "case.failed",
  "case.retried",
] as const satisfies HistoryKind[];
/** Most history rows read; past it, `truncated` is true. */
const HISTORY_LIMIT = 5000;
const EXAMPLES = 5;

const vExample = v.object({
  caseId: v.id("cases"),
  threadId: v.string(),
  detail: v.optional(v.string()),
});

export const lastDays = internalQuery({
  args: { days: v.optional(v.number()) },
  returns: v.object({
    since: v.number(),
    /** Cases started in the period, not counting the evals' own. */
    started: v.number(),
    truncated: v.boolean(),
    corrections: v.array(
      v.object({
        kind: v.string(),
        count: v.number(),
        examples: v.array(vExample),
      }),
    ),
    /** Which answers were changed most, by question key. */
    changedAnswers: v.array(
      v.object({ detail: v.string(), count: v.number() }),
    ),
    agents: vSpanSummary,
  }),
  handler: async (ctx, { days = 7 }) => {
    const since = Date.now() - days * DAY;
    const found = await ctx.db
      .query("caseEvents")
      .withIndex("by_creation_time", (q) => q.gt("_creationTime", since))
      .order("desc")
      .take(HISTORY_LIMIT + 1);
    const events = found.slice(0, HISTORY_LIMIT);

    // The evals drive real cases; they aren't people.
    const threads = new Map<Id<"cases">, string | null>();
    for (const { caseId } of events) {
      if (threads.has(caseId)) continue;
      const c = await ctx.db.get("cases", caseId);
      threads.set(caseId, c && !c.unmetered ? c.threadId : null);
    }
    const real = events.flatMap((event) => {
      const threadId = threads.get(event.caseId);
      return threadId ? [{ ...event, threadId }] : [];
    });

    const corrections = CORRECTIONS.map((kind) => {
      const all = real.filter((event) => event.kind === kind);
      return {
        kind,
        count: all.length,
        examples: all
          .slice(0, EXAMPLES)
          .map(({ caseId, threadId, detail }) => ({
            caseId,
            threadId,
            detail,
          })),
      };
    }).filter(({ count }) => count > 0);

    const changed = new Map<string, number>();
    for (const { kind, detail } of real) {
      if (kind === "answer.changed" && detail) {
        changed.set(detail, (changed.get(detail) ?? 0) + 1);
      }
    }

    return {
      since,
      started: real.filter((event) => event.kind === "case.started").length,
      truncated: found.length > HISTORY_LIMIT,
      corrections,
      changedAnswers: [...changed]
        .map(([detail, count]) => ({ detail, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10),
      agents: await summarizeSpans(ctx, since, "easygov/"),
    };
  },
});
