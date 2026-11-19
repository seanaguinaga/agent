// Pure helpers over a case's answers.

export type Answers = Record<string, string>;

/** The same answers always give the same string, whatever order they came in. */
export function fingerprint(answers: Answers): string {
  const sorted = Object.entries(answers).sort(([a], [b]) => (a < b ? -1 : 1));
  return JSON.stringify(sorted);
}

export function missingInputs(required: string[], answers: Answers): string[] {
  return required.filter((key) => !answers[key]);
}
