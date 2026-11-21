import { expect, test } from "vitest";
import { budget } from "./budget";

test("a packet's allowance is shared, and runs out", () => {
  const spend = budget({ browser: 2 });
  expect(spend.take("browser")).toBe(true);
  expect(spend.take("browser")).toBe(true);
  expect(spend.take("browser")).toBe(false);
  expect(spend.spent.browser).toBe(2);
});

test("what turned out to cost nothing is given back", () => {
  const spend = budget({ downloads: 1 });
  expect(spend.take("downloads")).toBe(true);
  spend.giveBack("downloads");
  expect(spend.take("downloads")).toBe(true);
});

test("a kind with no ceiling is only counted", () => {
  const spend = budget();
  for (let i = 0; i < 50; i++) expect(spend.take("pages")).toBe(true);
  spend.add({ bytes: 1200, unchanged: 1 });
  expect(spend.spent).toMatchObject({ pages: 50, bytes: 1200, unchanged: 1 });
});
