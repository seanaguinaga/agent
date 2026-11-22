// What finding a packet's forms may spend, and what it has spent. Pure.
//
// Every step that costs something asks here first, so the ceiling is the
// packet's, not each step's own: ten forms share one allowance, and a step
// that can't be afforded goes without.

export type Cost = {
  /** Requests for a form's file, whether or not one came back. */
  downloads: number;
  /** Hosted browser sessions: to read a page, or to collect a file. */
  browser: number;
  /** Calls to the search model, and to the decision model. */
  searches: number;
  decisions: number;
  /** Sites on a government's suffix judged whose they are. */
  vouches: number;
  /** Official pages requested for the links they carry. */
  pages: number;
  /** Bytes of form files downloaded. */
  bytes: number;
  /** Asks answered from what was held, with no request made. */
  reused: number;
  /** Files the server said hadn't changed: asked, not downloaded. */
  unchanged: number;
  /** Steps that went without because the allowance had run out. */
  refused: number;
};

export type Kind = keyof Cost;
export type Limits = Partial<Record<Kind, number>>;

export type Budget = {
  spent: Cost;
  /** Whether one more of `kind` is allowed. Counts it if so. */
  take(kind: Kind): boolean;
  /** Takes back one of `kind` that turned out not to be needed. */
  giveBack(kind: Kind): void;
  /** Counts spending that has already happened. */
  add(cost: Partial<Cost>): void;
};

/** A budget with these ceilings. A kind with none is only counted. */
export function budget(limits: Limits = {}): Budget {
  const spent: Cost = {
    downloads: 0,
    browser: 0,
    searches: 0,
    decisions: 0,
    vouches: 0,
    pages: 0,
    bytes: 0,
    reused: 0,
    unchanged: 0,
    refused: 0,
  };
  return {
    spent,
    take(kind) {
      if (spent[kind] >= (limits[kind] ?? Infinity)) return false;
      spent[kind]++;
      return true;
    },
    giveBack(kind) {
      spent[kind] = Math.max(0, spent[kind] - 1);
    },
    add(cost) {
      for (const [kind, n] of Object.entries(cost)) spent[kind as Kind] += n;
    },
  };
}
