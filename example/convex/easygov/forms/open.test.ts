// @vitest-environment node
// Opening protected forms: a real USCIS form that allows filling, and the
// same IRS form protected two ways that don't.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { openForFilling, runQpdf, UnusablePdf } from "./open";
import { inspectPdf } from "./pdf";

const fixture = (name: string) =>
  new Uint8Array(
    readFileSync(new URL(`./fixtures/${name}.pdf`, import.meta.url)),
  );

/** The IRS form, protected with qpdf: for the cases we must refuse. */
async function protect(args: string[]) {
  const out = await runQpdf(fixture("f8822"), ["--encrypt", ...args, "--"]);
  if (!out.bytes) throw new Error(`qpdf exited ${out.code}`);
  return out.bytes;
}

describe("opening a form to fill it", () => {
  test("an unprotected form comes back as it is", async () => {
    const bytes = fixture("f8822");
    expect(await openForFilling(bytes)).toEqual({ bytes, opened: false });
  });

  test("a form that opens without a password and allows filling is opened", async () => {
    // USCIS AR-11 as published: it can't be read until this is done.
    const published = fixture("ar-11");
    const { bytes, opened } = await openForFilling(published);
    expect(opened).toBe(true);
    const form = await inspectPdf(bytes);
    expect(form.fillable).toBe(true);
    expect(form.targets.length).toBeGreaterThan(20);
    expect(form.words[0]).toMatch(/AR-11/);
  });

  test("a form that doesn't allow filling is refused", async () => {
    const locked = await protect(["", "owner", "256", "--modify=none"]);
    await expect(openForFilling(locked)).rejects.toThrow(
      new UnusablePdf("Its publisher doesn't allow it to be filled in."),
    );
  });

  test("a form that needs a password is refused", async () => {
    const locked = await protect(["secret", "owner", "256"]);
    await expect(openForFilling(locked)).rejects.toThrow(
      new UnusablePdf("It needs a password to open."),
    );
  });
});
