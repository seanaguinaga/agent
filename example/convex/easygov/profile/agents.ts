// The one judgment call the profile needs a model for: an address typed or
// pasted as a single line, split into its parts for the person to confirm.
import { generateText, Output } from "ai";
import { v } from "convex/values";
import { z } from "zod/v4";
import { action } from "../../_generated/server";
import { languageModel } from "../../modelsForDemo";
import { checkFact, vAddress, type Address } from "./vocabulary";

/**
 * The parts of an address written as text, or null if it isn't one. Nothing
 * is filled in that the text doesn't say: a missing ZIP stays missing, and
 * the person completes it. Code then checks the state code and ZIP's shape.
 */
export async function addressFromText(text: string): Promise<Address | null> {
  if (!text.trim()) return null;
  const { output } = await generateText({
    model: languageModel,
    output: Output.object({
      schema: z.object({
        isAddress: z.boolean(),
        street: z.string().describe("Number and street name only."),
        unitType: z.string().describe('"Apt", "Ste", "Unit", "Fl", or "".'),
        unitNumber: z.string(),
        city: z.string(),
        state: z.string().describe("Two-letter code for a US state."),
        postalCode: z.string(),
        country: z.string().describe("Two-letter country code."),
        careOf: z.string().describe('A "c/o" name, or "".'),
      }),
    }),
    prompt: [
      "Split this postal address into its parts.",
      'Use only what is written. Leave a part as "" if the text does not give it: never look up or guess a ZIP code, city or state.',
      'If no country is written, use "US" only when the state or ZIP is plainly a US one.',
      `<address>${text.slice(0, 500)}</address>`,
    ].join("\n"),
  });
  if (!output.isAddress) return null;
  const { isAddress: _, ...parts } = output;
  const address: Address = {
    street: parts.street,
    unitType: parts.unitType || undefined,
    unitNumber: parts.unitNumber || undefined,
    city: parts.city,
    state: parts.state,
    postalCode: parts.postalCode,
    country: parts.country || "US",
    careOf: parts.careOf || undefined,
  };
  // Tidy what passes; hand back what doesn't as it is, for the person to fix.
  const checked = checkFact("homeAddress", address);
  return "problem" in checked ? address : (checked.value as Address);
}

/** Splits a typed address into parts, for an editor to show and confirm. */
export const parseAddress = action({
  args: { text: v.string() },
  returns: v.union(vAddress, v.null()),
  handler: async (_ctx, { text }): Promise<Address | null> =>
    await addressFromText(text),
});
