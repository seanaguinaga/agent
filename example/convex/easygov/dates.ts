// Dates as YYYY-MM-DD text, in UTC. Pure, so both the server and the test
// pages read them the same way.

export const DAY_MS = 24 * 60 * 60 * 1000;

/** The time of a YYYY-MM-DD date, or null if it isn't a real one. */
export function parseDate(text: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const time = Date.parse(`${text}T00:00:00Z`);
  // "2026-02-31" parses in some engines: it must come back as itself.
  return Number.isNaN(time) || formatDate(time) !== text ? null : time;
}

function formatDate(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

export function isDate(text: string): boolean {
  return parseDate(text) !== null;
}

/** Today, as YYYY-MM-DD. */
export function today(now: number): string {
  return formatDate(now);
}

/** The date `days` after a YYYY-MM-DD date, or undefined if it isn't one. */
export function addDays(date: string, days: number): string | undefined {
  const time = parseDate(date);
  return time === null ? undefined : formatDate(time + days * DAY_MS);
}
