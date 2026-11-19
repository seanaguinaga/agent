// What the deliver workflow writes.
import { v } from "convex/values";
import { internalMutation } from "../../../_generated/server";
import { writeCase } from "../../case/data";

export const prepare = internalMutation({
  args: { caseId: v.id("cases"), channel: v.string() },
  returns: v.null(),
  handler: async (ctx, { caseId, channel }) => {
    await writeCase(ctx, "deliver", caseId, {
      delivery: { status: "prepared", channel },
    });
    return null;
  },
});
