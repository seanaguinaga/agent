import { vWorkflowId } from "@convex-dev/workflow";
import { vWorkIdValidator } from "@convex-dev/workpool";
import { defineTable } from "convex/server";
import { v } from "convex/values";

export default {
  /**
   * Which workflow answers a thread, so a page can ask whether it's still
   * running (and retrying) or has failed, and restart it.
   */
  threadWorkflows: defineTable({
    threadId: v.string(),
    workflowId: vWorkflowId,
  }).index("by_threadId", ["threadId"]),
  /**
   * Follow-up questions whose answer is queued or streaming. While a row
   * exists the question can't be asked again; it goes when the job is over.
   */
  followUpJobs: defineTable({
    threadId: v.string(),
    promptMessageId: v.string(),
    workId: vWorkIdValidator,
  }).index("by_promptMessageId", ["promptMessageId"]),
};
