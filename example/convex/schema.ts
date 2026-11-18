import { defineSchema } from "convex/server";
import evalTables from "./evals/tables.js";
import ragTables from "./rag/tables.js";
import usageTables from "./usage_tracking/tables.js";
import workflowTables from "./workflows/tables.js";

export default defineSchema({
  ...evalTables,
  ...ragTables,
  ...usageTables,
  ...workflowTables,
});
