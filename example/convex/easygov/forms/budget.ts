// What finding a packet's forms may spend, and what it has spent. Pure.
//
// Every step that costs something (a download, a hosted browser, a search,
// a decision) asks here first, so the ceiling is the packet's, not each
// step's own: ten forms share one allowance, and a step that is refused goes
// without, as it would if the thing it wanted weren't there.

export type Cost = {
  /** Requests for a form's file, whether or not one came back. */
  downloads: number;
  /** Hosted browser sessions: to read a page, or to collect a file. */
  browser: number;
  /** Calls to the search model. */
  searches: number;
  /** Calls to the decision model. */
  decisions: number;
  /** Official pages requested for the links they carry. */
  pages: number;
  /** Files opened and read for what they say about themselves. */
  reads: number;
  /** Fetches answered from what was already held, with no request made. */
  reused: number;
  /** Bytes of form files downloaded. */
  bytes: number;
  /** Spending refused because the allowance had run out. */
  refused: number;
};

export type Kind = keyof Cost;
export type Limits = Partial<Record<Kind, number>>;

export type Budget = {
  spent: Cost;
  /** Whether one more of `kind` is allowed. Counts it if so. */
  take(kind: Kind): boolean;
  /** Counts spending that has already happened. */
  add(cost: Partial<Cost>): void;
  /** How many more of `kind` are allowed. */
  left(kind: Kind): number;
};

export const NOTHING: Cost = {
  downloads: 0,
  browser: 0,
  searches: 0,
  decisions: 0,
  pages: 0,
  reads: 0,
  reused: 0,
  bytes: 0,
  refused: 0,
};

/** A budget with these ceilings. A kind with none is only counted. */
export function budget(limits: Limits = {}): Budget {
  const spent = { ...NOTHING };
  const left = (kind: Kind) =>
    Math.max(0, (limits[kind] ?? Infinity) - spent[kind]);
  return {
    spent,
    left,
    take(kind) {
      if (left(kind) < 1) {
        spent.refused++;
        return false;
      }
      spent[kind]++;
      return true;
    },
    add(cost) {
      for (const [kind, n] of Object.entries(cost)) {
        spent[kind as Kind] += n;
      }
    },
  };
}
