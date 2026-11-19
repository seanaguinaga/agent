// The two agents. Intake chats until it knows the person's goal; selection
// proposes a process pack for it. Neither saves anything: the workflow's next
// mutation decides what to keep, so a retried model call can't leave a
// duplicate in the thread.
import { Agent } from "@convex-dev/agent";
import { vWorkflowId } from "@convex-dev/workflow";
import { Output } from "ai";
import { type Infer, v } from "convex/values";
import { z } from "zod/v4";
import { components, internal } from "../../_generated/api";
import { internalAction } from "../../_generated/server";
import { defaultConfig } from "../../agents/config";
import {
  normalizeFormId,
  parseJurisdiction,
  vProcessPackDefinition,
} from "../packs/schema";

// --- Intake -----------------------------------------------------------------

export const intakeAgent = new Agent(components.agent, {
  name: "Intake",
  instructions:
    "You help people say what legal or government task they need done. " +
    "Reply briefly and ask at most one question. " +
    "Once you know the task, set `goal` to one plain sentence describing it; " +
    "until then, set `goal` to null.",
  ...defaultConfig,
});

const turnSchema = z.object({
  reply: z.string().describe("What to say to the person."),
  goal: z.string().nullable().describe("The task, once it's clear."),
});

/**
 * Answers one user message. Saves nothing: `recordTurn` decides
 * what to keep, so a retried turn can't leave a duplicate reply.
 */
export const intakeTurn = internalAction({
  args: { caseId: v.id("cases"), promptMessageId: v.string() },
  returns: v.object({ reply: v.string(), goal: v.union(v.string(), v.null()) }),
  handler: async (
    ctx,
    { caseId, promptMessageId },
  ): Promise<{ reply: string; goal: string | null }> => {
    const { threadId }: { threadId: string } = await ctx.runQuery(
      internal.easygov.case.data.threadOf,
      { caseId },
    );
    const { object } = await intakeAgent.generateObject(
      ctx,
      { threadId },
      { promptMessageId, schema: turnSchema },
      { storageOptions: { saveMessages: "none" } },
    );
    return object;
  },
});

// --- Selection --------------------------------------------------------------
//
// Three model calls at most: read the request, compare the saved candidates,
// and draft a pack if none fits.

export const selectionAgent = new Agent(components.agent, {
  name: "Select process pack",
  instructions:
    "Identify the process pack that fits a person's goal. " +
    "Only select a pack for the same task, in a jurisdiction that covers the person's. " +
    "Authorities are named in many ways; compare what they do, not their labels.",
  ...defaultConfig,
});

export const proposalFields = {
  message: v.string(),
  packId: v.optional(v.id("processPacks")),
  draft: v.optional(vProcessPackDefinition),
  /** The request needs legal advice, not a process pack. */
  referral: v.optional(v.literal(true)),
  /** Where a referral applies, if the request said. */
  jurisdiction: v.optional(v.string()),
  needsClarification: v.optional(v.literal(true)),
  /** The goal and workflow it was proposed for, to drop a stale result. */
  origin: v.object({ goalVersion: v.number(), workflowId: vWorkflowId }),
};
const vProposal = v.object(proposalFields);

/** What the first call reads from the goal. Labels here only feed search. */
const zRequest = z.object({
  kind: z
    .enum(["process", "referral", "unclear"])
    .describe(
      "process: the person wants to understand, prepare for, or respond to a government or court matter, " +
        "e.g. make sense of a notice or make a checklist. " +
        "referral: the person asks what they should do legally, whether to sue or settle, or wants a lawyer. " +
        "unclear: one question would settle where or what it is.",
    ),
  message: z
    .string()
    .describe(
      "Addressed to the person: a brief sentence, the one question to ask, " +
        "or for a referral, that you'll connect them with legal help.",
    ),
  jurisdiction: z
    .string()
    .optional()
    .describe(
      'Where it applies, narrowest known: "us" for federal, "us/ca" for a state, "us/ca/alameda" for a county.',
    ),
  authority: z
    .string()
    .optional()
    .describe("Who handles it, e.g. Internal Revenue Service."),
  forms: z
    .array(z.string())
    .max(10)
    .optional()
    .describe("Official form numbers, e.g. IRS-8822."),
  searchTerms: z
    .string()
    .optional()
    .describe("Process terms and synonyms only, without personal details."),
});

const zDraft = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(600),
  aliases: z.array(z.string().trim().min(1).max(80)).max(10),
  inputQuestions: z
    .array(
      z.object({
        key: z.string().regex(/^[a-z][a-zA-Z0-9]{0,47}$/),
        question: z.string().trim().min(1).max(240),
      }),
    )
    .max(12)
    .refine((questions) => {
      const keys = questions.map(({ key }) => key);
      return (
        keys.length === new Set(keys).size &&
        keys.every((key) => !Object.hasOwn(Object.prototype, key))
      );
    }, "Each input must have a distinct key"),
  output: z.object({
    title: z.string().trim().min(1).max(120),
    checklist: z.array(z.string().trim().min(1).max(300)).min(1).max(12),
  }),
});

const noStorage = { storageOptions: { saveMessages: "none" } } as const;

/**
 * Proposes a process for the case's goal. The person still has to confirm
 * it; this only suggests one. Three model calls at most: read the request,
 * compare the saved candidates, and draft a pack if none fits. Nothing is
 * saved until `recordProposal`, so a retry is safe.
 */
export const propose = internalAction({
  args: { caseId: v.id("cases") },
  returns: vProposal,
  handler: async (ctx, { caseId }): Promise<Infer<typeof vProposal>> => {
    const { goal, goalVersion, threadId, workflowId } = await ctx.runQuery(
      internal.easygov.case.data.goalOf,
      { caseId },
    );
    const origin = { goalVersion, workflowId };
    const { output: request } = await selectionAgent.generateText(
      ctx,
      { threadId },
      {
        prompt: `Goal: ${goal}\nWhat kind of request is this, and where does it apply?`,
        output: Output.object({ schema: zRequest }),
      },
      noStorage,
    );
    const jurisdiction = parseJurisdiction(request.jurisdiction ?? "");
    if (
      request.kind === "unclear" ||
      (request.kind === "process" && !jurisdiction)
    ) {
      return {
        message:
          request.kind === "unclear"
            ? request.message
            : "Which state, county or country is this request for?",
        needsClarification: true,
        origin,
      };
    }
    const authority = request.authority?.trim() || undefined;
    const forms = [
      ...new Set((request.forms ?? []).map(normalizeFormId).filter(Boolean)),
    ];
    const terms = [request.searchTerms ?? "", authority ?? "", ...forms].join(
      " ",
    );

    // Search even for a referral: where advice ends and a process begins is a
    // judgment call, and a saved pack for the same task should win it.
    const packs = jurisdiction
      ? await ctx.runQuery(internal.easygov.packs.data.findMatch, {
          caseId,
          jurisdiction,
          terms,
        })
      : [];
    if (packs.length) {
      const { output: selected } = await selectionAgent.generateText(
        ctx,
        { threadId },
        {
          prompt: [
            `Goal: ${goal}`,
            `Jurisdiction: ${jurisdiction}`,
            "Which saved process pack is for the same task? Answer its number, or 0 if none is.",
            ...packs.map(
              (pack, i) =>
                `${i + 1}. ${pack.title} (${pack.jurisdiction}` +
                `${pack.authority ? `, ${pack.authority}` : ""}` +
                `${pack.forms.length ? `, forms ${pack.forms.join(", ")}` : ""}). ` +
                pack.description,
            ),
          ].join("\n"),
          output: Output.object({
            schema: z.object({
              choice: z.number().int().min(0).max(packs.length),
            }),
          }),
        },
        noStorage,
      );
      const match = packs[selected.choice - 1];
      if (match) {
        return {
          packId: match.id,
          message: `Suggested process: ${match.title}.`,
          origin,
        };
      }
    }

    if (request.kind === "referral" || !jurisdiction) {
      return {
        message: request.message,
        referral: true,
        jurisdiction: jurisdiction ?? undefined,
        origin,
      };
    }

    const { output: recipe } = await selectionAgent.generateText(
      ctx,
      { threadId },
      {
        prompt: [
          `Draft a reusable process pack for: ${request.searchTerms ?? goal}`,
          `Jurisdiction: ${jurisdiction}`,
          authority ? `Authority: ${authority}` : "",
          forms.length ? `Forms: ${forms.join(", ")}` : "",
          "Give it a title, description, common aliases, and only the questions needed to make a preparation checklist.",
          "Write a checklist that helps the person gather information and verify next steps with the relevant authority.",
          "Do not invent requirements, deadlines, eligibility, URLs, filing instructions, or personal details.",
          "Store questions and general guidance only. Do not include case facts, answers, or identifying information.",
        ]
          .filter(Boolean)
          .join("\n"),
        output: Output.object({ schema: zDraft }),
      },
      { contextOptions: { recentMessages: 0 }, ...noStorage },
    );
    return {
      origin,
      message: `I drafted a process pack for ${recipe.title}. Review the questions and checklist before confirming.`,
      draft: {
        ...recipe,
        jurisdiction,
        authority,
        forms,
        inputs: recipe.inputQuestions.map(({ key }) => key),
      },
    };
  },
});
