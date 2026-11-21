// The one judgment call a form needs a model for: what each place on it is
// asking, in terms of the profile's readings and the case's own questions.
// It's a draft. A person reviews it before it fills anything.
import { requireOperator } from "../operators";
import { generateText, Output } from "ai";
import { ConvexError, v } from "convex/values";
import { z } from "zod/v4";
import type { Id } from "../../_generated/dataModel";
import { mappingQuestions, type FormQuestion } from "./mapping";
import { vProcessPackQuestions } from "../packs/schema";
import { api, internal } from "../../_generated/api";
import {
  action,
  internalAction,
  type ActionCtx,
} from "../../_generated/server";
import { getAuthUserId } from "../../utils";
import { admitCall, chargeUsage } from "../limits";
import { languageModel } from "../../modelsForDemo";
import { READINGS, isReading } from "../profile/vocabulary";
import { isInputKey } from "../packs/schema";
import { clip } from "../text";
import type { Mapping } from "./schema";

/** What the model is shown of a target: where it is doesn't matter here. */
export type TargetBrief = {
  id: string;
  kind: "text" | "check";
  label: string;
  /** Boxes the PDF itself groups: only one of a group can be ticked. */
  group?: string;
};

const OPTION = /^[a-z][a-zA-Z0-9]{0,31}$/;

/**
 * A mapping for a form's targets, drafted from their labels. Only entries
 * that make sense are kept: a known target, and a reading or a well-formed
 * key. A target the model leaves out stays blank.
 */
export async function proposeMapping(
  ctx: ActionCtx,
  /** Who the call is charged to, besides everyone. */
  userId: string | undefined,
  title: string,
  targets: TargetBrief[],
): Promise<Mapping> {
  if (!targets.length) return [];
  const { output, usage } = await generateText({
    model: languageModel,
    output: Output.object({
      schema: z.object({
        entries: z.array(
          z.object({
            target: z.string(),
            use: z.enum(["input", "signature", "confidential", "blank"]),
            input: z.string().describe('The input key, for "input". Else "".'),
            question: z
              .string()
              .describe(
                'For a new key: the question to ask the person, short and plain. For a group of tick boxes, the question the whole group answers. Else "".',
              ),
            tick: z
              .enum(["", "one", "many", "yesno"])
              .describe(
                'For a tick box: "one" if it is one of several alternatives, "many" if several may be ticked ("check all that apply"), "yesno" if it stands alone. Else "".',
              ),
            option: z
              .string()
              .describe(
                'For a tick box in a group: a short camelCase name for this box\'s choice, from its label, e.g. "individual". Else "".',
              ),
            note: z
              .string()
              .describe(
                'For "signature" or "confidential": what the person adds there, in a few words. Else "".',
              ),
          }),
        ),
      }),
    }),
    prompt: [
      `Below are the places a value can go on the form "${title}", each with the words printed beside it.`,
      "The person filling it in is the filer. Say what goes in each place:",
      '- "input" with one of the profile keys below, when the place asks for that fact about the filer themself.',
      '- "input" with a new short camelCase key, when it asks the filer for something else about this matter ' +
        "(a new address, a prior name, a choice). Use the same key wherever the same fact is asked.",
      '- "signature" where the person signs, or dates their signature.',
      '- "confidential" for a Social Security number or other ID number: we do not hold these.',
      '- "blank" for a place about someone else (a spouse, a decedent, a representative), for office use, or if unsure.',
      "A whole address on one line takes the one-line address key; separate street, city, state and ZIP boxes take their own keys.",
      "The filer's old or current address is their home address. A new address is a new key, never a profile key.",
      'Tick boxes that answer one question (alternatives, or "check all that apply") share ONE input key, named for the question, ' +
        "and each gets its own option. Boxes marked with the same group are alternatives: only one can be ticked.",
      "<profile-keys>",
      ...Object.entries(READINGS).map(([key, { label }]) => `${key}: ${label}`),
      "</profile-keys>",
      "<places>",
      ...targets.map(
        ({ id, kind, label, group }) =>
          `${id} | ${kind}${group ? ` | group ${group}` : ""} | ${label}`,
      ),
      "</places>",
    ].join("\n"),
  });
  await chargeUsage(ctx, userId, usage.totalTokens);
  const briefs = new Map(targets.map((target) => [target.id, target]));
  const seen = new Set<string>();
  // Boxes the PDF groups are one question, whatever the model called them.
  const groupInput = new Map<string, string>();
  const mapping: Mapping = [];
  for (const entry of output.entries) {
    const { target, use } = entry;
    const brief = briefs.get(target);
    if (!brief || seen.has(target) || use === "blank") continue;
    seen.add(target);
    if (use === "signature" || use === "confidential") {
      const note = clip(entry.note, 160);
      if (note) mapping.push({ target, leave: { why: use, note } });
      continue;
    }
    let key = entry.input.trim();
    if (!isReading(key) && !isInputKey(key)) continue;
    const question =
      !isReading(key) && entry.question.trim()
        ? clip(entry.question, 240)
        : undefined;
    if (brief.kind !== "check") {
      mapping.push({ target, input: key, question });
      continue;
    }
    if (brief.group) {
      key = groupInput.get(brief.group) ?? key;
      groupInput.set(brief.group, key);
    }
    const option = OPTION.test(entry.option.trim())
      ? entry.option.trim()
      : `option${mapping.length + 1}`;
    if (entry.tick === "many" && !brief.group) {
      mapping.push({ target, input: key, question, includes: option });
    } else if (entry.tick === "one" || brief.group) {
      mapping.push({ target, input: key, question, equals: option });
    } else {
      mapping.push({ target, input: key, question, equals: "yes" });
    }
  }
  // A "group" of one box is just a yes or no.
  return mapping.map((entry) => {
    const alone =
      entry.input !== undefined &&
      (entry.equals ?? entry.includes) !== undefined &&
      mapping.filter((other) => other.input === entry.input).length === 1;
    if (!alone) return entry;
    const { includes: _includes, ...rest } = entry;
    return { ...rest, equals: "yes" };
  });
}

/** Drafts a mapping for an edition and saves it, unreviewed. */
export const draftMapping = action({
  args: { editionId: v.id("formEditions") },
  returns: v.number(),
  handler: async (ctx, { editionId }): Promise<number> => {
    await requireOperator(ctx);
    const found = await ctx.runQuery(api.easygov.forms.data.getEdition, {
      editionId,
    });
    if (!found) throw new ConvexError("Edition not found.");
    const userId = await getAuthUserId(ctx);
    await admitCall(ctx, userId);
    const mapping = await proposeMapping(
      ctx,
      userId,
      `${found.code} ${found.title}`,
      found.targets.map(({ id, kind, label, field, option }) => ({
        id,
        kind,
        label,
        // Boxes that share a field are a group the PDF declares.
        group: option !== undefined ? field : undefined,
      })),
    );
    await ctx.runMutation(api.easygov.forms.data.updateMapping, {
      editionId,
      mapping,
      reviewed: false,
    });
    return mapping.length;
  },
});

/** Pin this case's interpretation of the official bytes without changing the reviewed library mapping. */
export const compileSource = internalAction({
  args: {
    code: v.string(),
    sourceUrl: v.string(),
    jurisdiction: v.string(),
    /** The edition already fetched from `sourceUrl`, to not fetch it twice. */
    editionId: v.optional(v.id("formEditions")),
  },
  returns: v.object({
    blueprintId: v.id("formBlueprints"),
    questions: vProcessPackQuestions,
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    blueprintId: Id<"formBlueprints">;
    questions: FormQuestion[];
  }> => {
    const { editionId: fetched, ...source } = args;
    const sourced = fetched
      ? undefined
      : await ctx.runAction(internal.easygov.forms.actions.fetchSource, {
          formId: await ctx.runMutation(
            internal.easygov.forms.data.registerSource,
            source,
          ),
        });
    if (sourced && !sourced.ok) throw new Error(sourced.note);
    const editionId = fetched ?? sourced!.editionId;
    const edition = await ctx.runQuery(
      internal.easygov.forms.data.readEdition,
      {
        editionId,
      },
    );
    if (!edition?.targets.length)
      throw new Error("No writable places were found on the form.");
    const { targets } = edition;
    const latest = await ctx.runQuery(
      internal.easygov.forms.data.latestBlueprint,
      { editionId },
    );
    const cached =
      latest &&
      JSON.stringify(latest.targets) === JSON.stringify(targets) &&
      (edition.mappingStatus !== "reviewed" ||
        JSON.stringify(latest.mapping) === JSON.stringify(edition.mapping))
        ? latest
        : undefined;
    const mapping =
      cached?.mapping ??
      (edition.mappingStatus === "reviewed"
        ? edition.mapping
        : await proposeMapping(
            ctx,
            // Part of a case's work: admitted there, charged to everyone.
            undefined,
            args.code,
            targets.map(({ id, kind, label, field, option }) => ({
              id,
              kind,
              label,
              group: option !== undefined ? field : undefined,
            })),
          ));
    if (!mapping.length) throw new Error("The form needs manual completion.");
    const blueprintId =
      cached?.id ??
      (await ctx.runMutation(internal.easygov.forms.data.saveBlueprint, {
        editionId,
        targets,
        mapping,
      }));
    const labels = new Map(targets.map((t) => [t.id, t.label]));
    return {
      blueprintId,
      questions: mappingQuestions(
        mapping,
        Object.fromEntries(targets.map((t) => [t.id, t.kind])),
        (id) => labels.get(id) ?? id,
        (key) => (isReading(key) ? READINGS[key].label : undefined),
      ),
    };
  },
});
