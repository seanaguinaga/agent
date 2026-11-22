import { expect, test } from "vitest";
import { readingLine } from "./Phases";

test("each step of reading a scanned form is said in plain words", () => {
  const said = (
    ["reading", "retrying", "backup", "read", "readByBackup", "unread"] as const
  ).map((status) => readingLine({ code: "V62", status }));
  expect(said).toEqual([
    "Reading a scanned copy of V62",
    "Reading a scanned copy of V62: retrying",
    "Reading a scanned copy of V62 with the backup reader",
    "Read a scanned copy of V62",
    "Read a scanned copy of V62 with the backup reader",
    "Couldn’t read a scanned copy of V62; it may need completing by hand",
  ]);
});
