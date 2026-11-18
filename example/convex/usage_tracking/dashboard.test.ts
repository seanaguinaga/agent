import { expect, test } from "vitest";
import { api } from "../_generated/api";
import { initConvexTest } from "../setup.test";

test("usage and invoice previews are scoped to the demo user and selected period", async () => {
  const t = initConvexTest();
  await t.run(async (ctx) => {
    for (const [userId, billingPeriod] of [
      ["test user", "2026-11-01"],
      ["other", "2026-11-01"],
      ["test user", "2026-10-01"],
    ]) {
      await ctx.db.insert("rawUsage", {
        userId,
        billingPeriod,
        provider: "test",
        model: "test",
        usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
      });
      await ctx.db.insert("invoices", {
        userId,
        billingPeriod,
        amount: 1,
        status: "pending",
      });
    }
  });
  const args = { billingPeriod: "2026-11-01" };
  const usage = await t.query(api.usage_tracking.dashboard.listUsage, args);
  const invoices = await t.query(
    api.usage_tracking.dashboard.listInvoices,
    args,
  );
  expect(usage).toHaveLength(1);
  expect(usage[0]).toMatchObject({
    userId: "test user",
    billingPeriod: args.billingPeriod,
  });
  expect(invoices).toHaveLength(1);
  expect(invoices[0]).toMatchObject({
    userId: "test user",
    billingPeriod: args.billingPeriod,
  });
  expect(
    await t.query(api.usage_tracking.dashboard.listUsage, {
      billingPeriod: "2027-01-01",
    }),
  ).toEqual([]);
});
