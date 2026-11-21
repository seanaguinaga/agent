import { defineSchema } from "convex/server";
import debuggingTables from "./debugging/tables.js";
import easygovTables from "./easygov/schema.js";
import evalTables from "./evals/tables.js";
import ragTables from "./rag/tables.js";
import usageTables from "./usage_tracking/tables.js";
import workflowTables from "./workflows/tables.js";

export default defineSchema({
  ...debuggingTables,
  ...easygovTables,
  ...evalTables,
  ...ragTables,
  ...usageTables,
  ...workflowTables,
});
