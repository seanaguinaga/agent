// @vitest-environment node
// What is kept between cases, all on the address: how it answered, the file
// it served, and the form it was chosen for.
import { expect, test } from "vitest";
import { internal } from "../../_generated/api";
import { initConvexTest } from "../../setup.test";
import type { T } from "../case/cases.testkit";

const data = internal.easygov.forms.data;
const dir = "https://www.dir.ca.gov/dwc";

/** An address that served a file, known by `sha256`, printing `revision`. */
const served = (t: T, name: string, sha256 = name, revision = 201601) =>
  t.mutation(data.recordAddress, {
    key: `www.dir.ca.gov/dwc/${name}.pdf`,
    url: `${dir}/${name}.pdf`,
    answer: {
      outcome: "file",
      sha256,
      opening: "DWC 1",
      facts: { pages: 1, places: 3, language: "en", revision },
    },
  });
const choose = (t: T, name: string, code = "DWC-1") =>
  t.mutation(data.rememberChosen, {
    jurisdiction: "us/ca",
    code,
    url: `${dir}/${name}.pdf`,
  });
const remembered = async (t: T, code = "DWC-1", jurisdiction = "us/ca") =>
  (await t.query(data.knownSources, { jurisdiction, code })).map(
    ({ url }) => url,
  );

test("a form's chosen address is remembered under any spelling of its code", async () => {
  const t = initConvexTest();
  await served(t, "a");
  await choose(t, "a", "DWC 1");
  expect(await remembered(t, "DWC-1")).toEqual([`${dir}/a.pdf`]);
  expect(await remembered(t, "DWC Form 1")).toEqual([`${dir}/a.pdf`]);
  // Another form with the same number, or in another place, isn't it.
  expect(await remembered(t, "RCI-1")).toEqual([]);
  expect(await remembered(t, "DWC-1", "us")).toEqual([]);
});

test("a chosen address keeps the words its link gave it", async () => {
  const t = initConvexTest();
  await served(t, "a");
  await t.mutation(data.rememberChosen, {
    jurisdiction: "us/ca",
    code: "DWC-1",
    url: `${dir}/a.pdf`,
    linkedAs: "DWC 1 Claim Form",
  });
  expect(
    await t.query(data.knownSources, { jurisdiction: "us/ca", code: "DWC-1" }),
  ).toEqual([{ url: `${dir}/a.pdf`, linkedAs: "DWC 1 Claim Form" }]);
});

test("a second copy of the same file and an earlier revision are forgotten", async () => {
  const t = initConvexTest();
  await served(t, "old", "old", 201601);
  await served(t, "new", "new", 202401);
  await served(t, "mirror", "new", 202401);
  await choose(t, "old");
  await choose(t, "new");
  expect(await remembered(t)).toEqual([`${dir}/new.pdf`]);
  await choose(t, "mirror");
  expect(await remembered(t)).toEqual([`${dir}/mirror.pdf`]);
  await choose(t, "mirror");
  expect(await remembered(t)).toHaveLength(1);
});

test("a different file of the same revision stays, but only a few are kept", async () => {
  const t = initConvexTest();
  for (const name of ["a", "b", "c", "d"]) {
    await served(t, name);
    await choose(t, name);
  }
  // One poor choice doesn't push out a good one; the oldest of four goes.
  expect(await remembered(t)).toEqual(
    ["d", "c", "b"].map((name) => `${dir}/${name}.pdf`),
  );
});

test("how an address answered is kept once, and failures are counted in a row", async () => {
  const t = initConvexTest();
  const key = "www.dir.ca.gov/dwc/a.pdf";
  const gone = {
    key,
    url: `${dir}/a.pdf`,
    answer: { outcome: "gone" as const, note: "The source answered 404." },
  };
  await t.mutation(data.recordAddress, gone);
  await t.mutation(data.recordAddress, gone);
  expect(await t.query(data.addressOf, { key })).toMatchObject({
    outcome: "gone",
    failures: 2,
  });
  await served(t, "a");
  await choose(t, "a");
  // A page of links is not a failure, and the choice outlives a new answer.
  const links = [{ url: `${dir}/b.pdf`, label: "DWC 1", pdf: true }];
  await t.mutation(data.recordAddress, {
    ...gone,
    answer: { outcome: "page", links },
  });
  expect(await t.query(data.addressOf, { key })).toMatchObject({
    outcome: "page",
    failures: 0,
    links,
  });
  expect(await remembered(t)).toEqual([`${dir}/a.pdf`]);
  expect(
    await t.run((ctx) => ctx.db.query("formAddresses").collect()),
  ).toHaveLength(1);
});
