import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config.js";

// Evals call a real model, so they run separately from `npm test`.
export default mergeConfig(
  base,
  defineConfig({
    test: {
      include: ["example/convex/**/*.eval.ts"],
      testTimeout: 120_000,
      // `fake.weather` is shared, so cases must not overlap.
      fileParallelism: false,
    },
  }),
);
