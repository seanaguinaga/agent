import { query } from "../_generated/server";
import { components } from "../_generated/api";

export const unusedFiles = query({
  args: {},
  handler: async (ctx) => {
    const files = await ctx.runQuery(components.agent.files.getFilesToDelete, {
      paginationOpts: { cursor: null, numItems: 100 },
    });
    return {
      files: files.page.map((file) => ({
        fileId: file._id,
        lastTouchedAt: file.lastTouchedAt,
        eligible: file.lastTouchedAt < Date.now() - 24 * 60 * 60 * 1000,
      })),
      isDone: files.isDone,
    };
  },
});
