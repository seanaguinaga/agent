// What a case may cost. See https://docs.convex.dev/agents/rate-limiting
//
// The person drives a case, so nothing here stops them: there's no count of
// tries. What's limited is how fast model work starts and how many tokens
// it spends, for one person and for everyone, and how much work one case
// may start on its own. Every model call in easygov is charged here: an
// agent's through `chargeTokens`, any other through `chargeUsage`.
import type { UsageHandler } from "@convex-dev/agent";
import { HOUR, MINUTE, RateLimiter } from "@convex-dev/rate-limiter";
import { components } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx, MutationCtx } from "../_generated/server";
import { usageHandler } from "../usage_tracking/usageHandler";

/** Any ctx that can run a mutation: an action's, or an agent's. */
type RunCtx = Pick<ActionCtx, "runQuery" | "runMutation">;

export const limits = new RateLimiter(components.rateLimiter, {
  // Chat messages one person may send. Over it, the message is refused.
  caseMessages: {
    kind: "token bucket",
    period: MINUTE,
    rate: 20,
    capacity: 10,
  },
  // Model work started for one person, and the tokens it used. Over either,
  // their work waits its turn.
  caseWorkPerUser: {
    kind: "token bucket",
    period: HOUR,
    rate: 120,
    capacity: 40,
  },
  caseTokensPerUser: {
    kind: "token bucket",
    period: HOUR,
    rate: 500_000,
    capacity: 1_000_000,
  },
  // The same for everyone together: a guest key costs nothing to make, so
  // a limit per person alone caps nothing.
  caseWorkGlobal: {
    kind: "token bucket",
    period: MINUTE,
    rate: 120,
    capacity: 240,
  },
  caseTokensGlobal: { kind: "token bucket", period: MINUTE, rate: 1_000_000 },
  // Work one case starts. No person edits this fast: it's a runaway, and
  // the case parks until someone looks.
  caseWorkPerCase: {
    kind: "token bucket",
    period: HOUR,
    rate: 60,
    capacity: 30,
  },
});

/**
 * Whether model work may start for this case now. "wait" says how long until
 * the person's (or everyone's) budget allows it; "runaway" means the case
 * itself has started too much.
 */
export async function admitWork(
  ctx: MutationCtx,
  c: { _id: Id<"cases">; userId: string; unmetered?: boolean },
): Promise<
  { ok: true } | { ok: false; wait: number } | { ok: false; runaway: true }
> {
  // An eval's case: the operator's own spend.
  if (c.unmetered) return { ok: true };
  const key = c.userId;
  // Tokens are spent after the fact, so a budget can be in debt: only look.
  for (const spent of [
    await limits.check(ctx, "caseTokensPerUser", { key }),
    await limits.check(ctx, "caseTokensGlobal"),
  ]) {
    if (!spent.ok) return { ok: false, wait: spent.retryAfter };
  }
  // Checked before anything is taken, so waiting costs nothing.
  for (const turn of [
    await limits.check(ctx, "caseWorkPerUser", { key }),
    await limits.check(ctx, "caseWorkGlobal"),
  ]) {
    if (!turn.ok) return { ok: false, wait: turn.retryAfter };
  }
  const own = await limits.limit(ctx, "caseWorkPerCase", { key: c._id });
  if (!own.ok) return { ok: false, runaway: true };
  await limits.limit(ctx, "caseWorkPerUser", { key });
  await limits.limit(ctx, "caseWorkGlobal");
  return { ok: true };
}

/**
 * Charges the tokens a model call used to the person (if there is one) and
 * to everyone, once they're known. That can put a budget in debt, which
 * `admitWork` and `admitCall` wait out or refuse.
 */
export async function chargeUsage(
  ctx: RunCtx,
  userId: string | undefined,
  totalTokens: number | undefined,
): Promise<void> {
  const count = totalTokens ?? 0;
  if (count <= 0) return;
  if (userId) {
    await limits.limit(ctx, "caseTokensPerUser", {
      key: userId,
      count,
      reserve: true,
    });
  }
  await limits.limit(ctx, "caseTokensGlobal", { count, reserve: true });
}

/** The agents' usage handler: every call an agent makes is charged. */
export const chargeTokens: UsageHandler = async (ctx, args) => {
  await chargeUsage(ctx, args.userId, args.usage.totalTokens);
  await usageHandler(ctx, args);
};

/**
 * For a model call a person asks for directly, outside any case's work:
 * it's refused, with the time to retry, when their budget or everyone's is
 * spent. Charge what it used afterwards with `chargeUsage`.
 */
export async function admitCall(ctx: RunCtx, userId: string): Promise<void> {
  const key = userId;
  await limits.check(ctx, "caseTokensPerUser", { key, throws: true });
  await limits.check(ctx, "caseTokensGlobal", { throws: true });
  await limits.limit(ctx, "caseWorkPerUser", { key, throws: true });
  await limits.limit(ctx, "caseWorkGlobal", { throws: true });
}
