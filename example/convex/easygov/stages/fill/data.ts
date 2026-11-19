// What the fill workflow writes.
import { v } from "convex/values";
import { internalMutation } from "../../../_generated/server";
import { fingerprint } from "../../case/answers";
import { writeCase } from "../../case/data";

export const write = internalMutation({
  args: { caseId: v.id("cases") },
  returns: v.null(),
  handler: async (ctx, { caseId }) => {
    const found = await ctx.db.get("cases", caseId);
    if (!found) return null;
    const packId = found.processPack?.definition?.id;
    const pack = packId ? await ctx.db.get("processPacks", packId) : null;
    const summary = JSON.stringify({
      process: pack?.title,
      answers: found.answers,
      output: pack?.output,
    });
    await writeCase(ctx, "fill", caseId, {
      artifact: { summary, fingerprint: fingerprint(found.answers) },
    });
    return null;
  },
});
