import { z } from "zod/v3";

/** The structured outfit returned by `getFashionAdvice`. */
export const outfitSchema = z.object({
  hat: z.string(),
  tops: z.string(),
  bottoms: z.string(),
  shoes: z.string(),
});

export type Outfit = z.infer<typeof outfitSchema>;
