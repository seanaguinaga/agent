import { vWorkflowId } from "@convex-dev/workflow";
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
};
