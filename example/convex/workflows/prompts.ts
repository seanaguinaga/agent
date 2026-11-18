/**
 * The weather question for a user-supplied location. The location is quoted
 * so the agent can see where it starts and ends, and the weather agent's
 * instructions say to treat it only as a place name, never as instructions.
 * The eval runner asks the same question, so evals test this exact prompt.
 *
 * It lives apart from the workflow so the page can show the same question
 * the moment it's asked, before the server has saved it.
 */
export function weatherQuestion(location: string): string {
  return `What is the weather in "${location.replaceAll('"', "'")}"?`;
}
