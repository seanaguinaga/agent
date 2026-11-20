// Fitting text a model wrote into a bounded field.

/**
 * The text on one line, and visibly cut short if it is too long to keep
 * whole: at a word, ending in "…", so a cut value never passes for a
 * complete one.
 */
export function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length <= max) return line;
  const cut = line.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
