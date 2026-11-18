import { v } from "convex/values";
import { query } from "../_generated/server";
import { getAuthUserId } from "../utils";

export const listUsage = query({
  args: { billingPeriod: v.string() },
  handler: async (ctx, { billingPeriod }) => {
    const userId = await getAuthUserId(ctx);
    return ctx.db
      .query("rawUsage")
      .withIndex("billingPeriod_userId", (q) =>
        q.eq("billingPeriod", billingPeriod).eq("userId", userId),
      )
      .order("desc")
      .take(100);
  },
});

export const listInvoices = query({
  args: { billingPeriod: v.string() },
  handler: async (ctx, { billingPeriod }) => {
    const userId = await getAuthUserId(ctx);
    return ctx.db
      .query("invoices")
      .withIndex("billingPeriod_userId", (q) =>
        q.eq("billingPeriod", billingPeriod).eq("userId", userId),
      )
      .order("desc")
      .take(100);
  },
});
