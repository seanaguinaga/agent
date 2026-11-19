// The one judgment call a form needs a model for: what each place on it is
// asking, in terms of the profile's readings and the case's own questions.
// It's a draft. A person reviews it before it fills anything.
import { generateText, Output } from "ai";
import { ConvexError, v } from "convex/values";
import { z } from "zod/v4";
import { api } from "../../_generated/api";
import { action } from "../../_generated/server";
import { languageModel } from "../../modelsForDemo";
import { READINGS, isReading } from "../profile/vocabulary";
import type { Mapping } from "./schema";

/** What the model is shown of a target: where it is doesn't matter here. */
export type TargetBrief = {
  id: string;
  kind: "text" | "check";
  label: string;
  /** Boxes the PDF itself groups: only one of a group can be ticked. */
  group?: string;
};

const INPUT_KEY = /^[a-z][a-zA-Z0-9]{0,47}$/;
const OPTION = /^[a-z][a-zA-Z0-9]{0,31}$/;

/**
 * A mapping for a form's targets, drafted from their labels. Only entries
 * that make sense are kept: a known target, and a reading or a well-formed
 * key. A target the model leaves out stays blank.
 */
export async function proposeMapping(
  title: string,
  targets: TargetBrief[],
): Promise<Mapping> {
  if (!targets.length) return [];
  const { output } = await generateText({
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
      const note = entry.note.trim().slice(0, 160);
      if (note) mapping.push({ target, leave: { why: use, note } });
      continue;
    }
    let key = entry.input.trim();
    if (!isReading(key) && !INPUT_KEY.test(key)) continue;
    const question =
      !isReading(key) && entry.question.trim()
        ? entry.question.trim().slice(0, 240)
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
    const found = await ctx.runQuery(api.easygov.forms.data.edition, {
      editionId,
    });
    if (!found) throw new ConvexError("Edition not found.");
    const mapping = await proposeMapping(
      `${found.code} ${found.title}`,
      found.targets.map(({ id, kind, label, field, option }) => ({
        id,
        kind,
        label,
        // Boxes that share a field are a group the PDF declares.
        group: option !== undefined ? field : undefined,
      })),
    );
    await ctx.runMutation(api.easygov.forms.data.saveMapping, {
      editionId,
      mapping,
      reviewed: false,
    });
    return mapping.length;
  },
});
