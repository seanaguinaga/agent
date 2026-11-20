// The operator's tools are closed to an account that isn't one.
import { afterEach, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import { initConvexTest } from "../setup.test";

afterEach(() => vi.unstubAllEnvs());

test("forms, evals and the test pages' functions are for operators", async () => {
  const t = initConvexTest();
  // The example's fixed identity is the operator until someone else is named.
  expect(await t.query(api.easygov.forms.data.listForms, {})).toEqual([]);

  vi.stubEnv("EASYGOV_OPERATORS", "someone else");
  await expect(t.query(api.easygov.forms.data.listForms, {})).rejects.toThrow(
    /Operators only/,
  );
  await expect(
    t.mutation(api.easygov.evals.runner.start, { note: "x" }),
  ).rejects.toThrow(/Operators only/);
  await expect(t.mutation(api.easygov.dev.seed, {})).rejects.toThrow(
    /Operators only/,
  );
  // The product's own pages stay open.
  const landings = await t.query(api.easygov.packs.public.listLandings, {
    paginationOpts: { cursor: null, numItems: 5 },
  });
  expect(landings.page).toEqual([]);
});
