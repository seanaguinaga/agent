// The easygov tables, spread into the root schema.
import { vWorkflowId } from "@convex-dev/workflow";
import { defineTable } from "convex/server";
import { v } from "convex/values";
import { vPlanStep } from "./validators";

const vStepState = v.object({
  status: v.union(
    v.literal("active"),
    v.literal("done"),
    // The step finished by sending the case back to an earlier step.
    v.literal("sentBack"),
    v.literal("stopped"),
    v.literal("failed"),
    // A retry or cancel is on its way to the parent workflow.
    v.literal("recovering"),
  ),
  /** How many times the step has started. Part of its workflow step name. */
  visits: v.number(),
  error: v.optional(v.string()),
});

export const caseFields = {
  userId: v.string(),
  /** The customer conversation. Agents read it; the person sees it. */
  threadId: v.string(),
  /** The newest user message no agent has answered yet. */
  pendingMessageId: v.optional(v.string()),
  status: v.union(
    v.literal("active"),
    v.literal("done"),
    v.literal("stopped"),
    v.literal("failed"),
    v.literal("canceled"),
  ),
  endReason: v.optional(v.string()),
  /** Bumped by `send` and by every routing decision, to reject stale sends. */
  seq: v.number(),

  // The plan this case has pinned, and how far along it is.
  processKey: v.optional(v.string()),
  plan: v.array(vPlanStep),
  stepStatus: v.record(v.string(), vStepState),
  /** How many steps stages have appended, to cap it. */
  appended: v.number(),

  // Where the case is now. `advance` sets the first two together.
  stage: v.optional(v.string()),
  activeStepId: v.optional(v.string()),
  /** The running stage workflow, which `send` nudges. */
  activeWorkflowId: v.optional(vWorkflowId),
  parentWorkflowId: v.optional(vWorkflowId),

  // Facts. `send` and the stages write them; stages wait on them.
  intake: v.optional(v.object({ goal: v.string() })),
  route: v.optional(
    v.object({
      status: v.union(
        v.literal("proposed"),
        v.literal("confirmed"),
        v.literal("rejected"),
      ),
      processKey: v.optional(v.string()),
    }),
  ),
  answers: v.record(v.string(), v.string()),
  flags: v.array(v.string()),
  artifact: v.optional(
    v.object({ summary: v.string(), fingerprint: v.string() }),
  ),
  /** The fingerprint of the artifact the person approved. */
  approval: v.optional(v.object({ fingerprint: v.string() })),
  delivery: v.optional(
    v.object({ status: v.literal("prepared"), channel: v.string() }),
  ),
};

export const vCaseDoc = v.object({
  _id: v.id("cases"),
  _creationTime: v.number(),
  ...caseFields,
});

export default {
  cases: defineTable(caseFields).index("by_userId", ["userId"]),
  /** An append-only log of routing decisions, for debugging a case. */
  caseEvents: defineTable({
    caseId: v.id("cases"),
    kind: v.string(),
    detail: v.optional(v.string()),
  }).index("by_caseId", ["caseId"]),
  referrals: defineTable({
    caseId: v.id("cases"),
    userId: v.string(),
    kind: v.string(),
    status: v.literal("open"),
  }).index("by_caseId_and_kind", ["caseId", "kind"]),
};
