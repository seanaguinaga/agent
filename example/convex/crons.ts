import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// See the docs at https://docs.convex.dev/agents/files
crons.interval(
  "deleteUnusedFiles",
  { hours: 1 },
  internal.files.vacuum.deleteUnusedFiles,
  {},
);

// A case shared with a lawyer that no firm took is handed back to its person.
crons.interval(
  "expireEasygovReferrals",
  { hours: 6 },
  internal.easygov.firms.data.expireReferrals,
  {},
);

// Who each .gov domain belongs to, from CISA's register: what decides
// whether a form's file is on its authority's own site.
crons.weekly(
  "importOfficialSites",
  { dayOfWeek: "monday", hourUTC: 6, minuteUTC: 17 },
  internal.easygov.forms.sites.importSites,
  {},
);

// Each published pack's forms are asked again once a week, so a pack whose
// file changed, expired or moved is marked stale (see packs/freshness.ts).
crons.daily(
  "sweepEasygovPacks",
  { hourUTC: 7, minuteUTC: 23 },
  internal.easygov.packs.freshness.sweepPacks,
  { cursor: null },
);

// Agent spans are kept for 30 days (see debugging/spans.ts).
crons.daily(
  "pruneSpans",
  { hourUTC: 5, minuteUTC: 17 },
  internal.debugging.spans.prune,
  {},
);

export default crons;
