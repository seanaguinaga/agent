// The test pages' seed is safe to press twice.
import { expect, test } from "vitest";
import { api } from "../_generated/api";
import { initConvexTest } from "../setup.test";

test("seeding twice leaves one of each fixture pack and one firm", async () => {
  const t = initConvexTest();
  const first = await t.mutation(api.easygov.dev.seed, {});
  const second = await t.mutation(api.easygov.dev.seed, {});
  expect(second).toEqual(first);
  expect(Object.keys(first.packs).sort()).toEqual([
    "irs8822",
    "ssaAppeal",
    "wageClaim",
  ]);
  expect(await t.query(api.easygov.dev.packs, {})).toHaveLength(3);
  expect(await t.query(api.easygov.dev.firms, {})).toHaveLength(1);
  const found = await t.query(api.easygov.dev.searchPacks, {
    jurisdiction: "us/ca/alameda",
    terms: "my employer owes me wages",
    mine: false,
  });
  expect(found?.map((pack) => pack.title)).toContain(
    "Unpaid wages demand letter",
  );
});
