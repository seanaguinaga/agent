import type { ToolCtx } from "@convex-dev/agent";
import { internal } from "../_generated/api";
import type { WeatherReport } from "../tools/weather";
import { EVAL_USER_PREFIX, getCase } from "./cases";

/**
 * The fixed weather for an eval trial's thread.
 *
 * Returns `undefined` for every real thread (no extra query), the case's
 * weather for an eval thread, or `null` when the case's place doesn't exist.
 */
export async function evalWeatherFor(
  ctx: ToolCtx,
): Promise<WeatherReport | null | undefined> {
  if (!ctx.userId?.startsWith(EVAL_USER_PREFIX) || !ctx.threadId) {
    return undefined;
  }
  const caseId: string | null = await ctx.runQuery(
    internal.evals.runner.caseForThread,
    { threadId: ctx.threadId },
  );
  if (!caseId) {
    throw new Error(`No eval trial for thread ${ctx.threadId}`);
  }
  return getCase(caseId).weather;
}
