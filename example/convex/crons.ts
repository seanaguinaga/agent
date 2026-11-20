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

export default crons;
