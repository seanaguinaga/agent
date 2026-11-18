import { defineApp } from "convex/server";
import agent from "@convex-dev/agent/convex.config";
import workflow from "@convex-dev/workflow/convex.config";
import workpool from "@convex-dev/workpool/convex.config";
import rateLimiter from "@convex-dev/rate-limiter/convex.config";
import rag from "@convex-dev/rag/convex.config";

const app = defineApp();
app.use(agent);
app.use(workflow);
// Runs the weather workflow page's follow-up answers.
app.use(workpool, { name: "followUpWorkpool" });
app.use(rateLimiter);
app.use(rag);

export default app;
