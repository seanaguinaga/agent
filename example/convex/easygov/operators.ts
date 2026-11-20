// Who may run the operator's tools: the forms registry, the evals, and the
// test pages' seeding. One check, so swapping in real sign-in changes one
// place.
import { ConvexError } from "convex/values";
import type { ActionCtx, QueryCtx } from "../_generated/server";
import { getAuthUserId } from "../utils";

/**
 * The accounts that are operators: `EASYGOV_OPERATORS`, separated by commas.
 * Unset, it's the example's fixed test identity, which no real account is:
 * once sign-in is real, nobody is an operator until the variable names them.
 */
function operators(): string[] {
  return (process.env.EASYGOV_OPERATORS ?? "test user")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

/** The caller, if they're an operator. */
export async function requireOperator(
  ctx: QueryCtx | ActionCtx,
): Promise<string> {
  const userId = await getAuthUserId(ctx);
  if (!userId || !operators().includes(userId)) {
    throw new ConvexError("Operators only.");
  }
  return userId;
}
