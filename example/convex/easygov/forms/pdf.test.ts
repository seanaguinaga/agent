// @vitest-environment node
// The PDF core, against the real IRS Form 8822 and a flattened copy of it.
import { readFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
import { beforeAll, describe, expect, test } from "vitest";
import { fillPdf, inspectPdf, verifyPdf, type Inspection } from "./pdf";
import { namesForm } from "./sources";

const original = new Uint8Array(
  readFileSync(new URL("./fixtures/f8822.pdf", import.meta.url)),
);
let fillable: Inspection;
let flatBytes: Uint8Array;
let flat: Inspection;

beforeAll(async () => {
  fillable = await inspectPdf(original);
  // The same form with its fields removed: a real flat government PDF.
  const doc = await PDFDocument.load(original);
  doc.getForm().flatten();
  flatBytes = await doc.save();
  flat = await inspectPdf(flatBytes);
});

const overlapRatio = (a: Inspection["targets"][number], b: typeof a) => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / (a.w * a.h + b.w * b.h - w * h);
};

describe("a fillable form", () => {
  test("gives its edition and its fields, each with what the form asks there", () => {
    expect(fillable).toMatchObject({
      pages: 2,
      edition: "Rev. February 2021",
      fillable: true,
    });
    expect(fillable.targets).toHaveLength(25);
    const labels = fillable.targets.map((t) => `${t.kind}: ${t.label}`);
    expect(labels).toContain(
      "check: Individual income tax returns (Forms 1040, 1040-SR, 1040-NR, etc.)",
    );
    expect(labels.some((l) => /^text: 3a Your name/.test(l))).toBe(true);
    expect(labels.some((l) => /social security number/i.test(l))).toBe(true);
    // Its own words say which form it is, whatever address it came from.
    expect(namesForm("IRS-8822", fillable.words[0])).toBe(true);
    expect(namesForm("IRS-8821", fillable.words[0])).toBe(false);
    // Every field says something about itself.
    expect(fillable.targets.filter((t) => !t.label)).toEqual([]);
  });

  test("is filled, and reads back what was written", async () => {
    const name = fillable.targets.find((t) => /^3a Your name/.test(t.label))!;
    const box = fillable.targets.find((t) => t.kind === "check")!;
    const values = { [name.id]: "Ada King Lovelace", [box.id]: true };
    const { bytes, omissions } = await fillPdf(
      original,
      fillable.targets,
      values,
    );
    expect(omissions).toEqual([]);
    expect(await verifyPdf(bytes, fillable.targets, values)).toEqual([]);
    // The check is real: the blank form doesn't pass it.
    expect(await verifyPdf(original, fillable.targets, values)).toHaveLength(2);
  });

  test("a value too long for its box is left out and said, not cut short", async () => {
    const ssn = fillable.targets.find((t) => t.maxLength === 11)!;
    const { omissions } = await fillPdf(original, fillable.targets, {
      [ssn.id]: "123-45-67890",
    });
    expect(omissions).toEqual([
      {
        target: ssn.id,
        reason: "It's longer than the 11 characters the box takes.",
      },
    ]);
  });
});

describe("the same form, flat", () => {
  test("its blanks are found on the page, where the fields were", () => {
    expect(flat.fillable).toBe(false);
    const page1 = fillable.targets.filter((t) => t.page === 1);
    const found = page1.filter((field) =>
      flat.targets.some(
        (region) =>
          region.page === 1 &&
          region.kind === field.kind &&
          overlapRatio(field, region) > 0.5,
      ),
    );
    // Scored against the fillable original: most fields, and few extras.
    expect(found.length / page1.length).toBeGreaterThanOrEqual(0.85);
    // The extras are real blanks the fillable form has no field for: the
    // signature and date lines.
    expect(flat.targets.filter((t) => t.page === 1).length).toBeLessThanOrEqual(
      page1.length + 8,
    );
    expect(flat.targets.filter((t) => t.kind === "check")).toHaveLength(3);
  });

  test("is filled by drawing, and the text is read back from inside its space", async () => {
    const name = flat.targets.find((t) => /^3a Your name/.test(t.label))!;
    const box = flat.targets.find((t) => t.kind === "check")!;
    const values = { [name.id]: "Ada King Lovelace", [box.id]: true };
    const { bytes, omissions } = await fillPdf(flatBytes, flat.targets, values);
    expect(omissions).toEqual([]);
    expect(await verifyPdf(bytes, flat.targets, values)).toEqual([]);
    expect(await verifyPdf(flatBytes, flat.targets, values)).toHaveLength(2);
  });

  test("text that can't fit its space is left out", async () => {
    const narrow = [...flat.targets]
      .filter((t) => t.kind === "text")
      .sort((a, b) => a.w - b.w)[0];
    const { omissions } = await fillPdf(flatBytes, flat.targets, {
      [narrow.id]: "x".repeat(200),
    });
    expect(omissions).toEqual([
      { target: narrow.id, reason: "It doesn't fit the space." },
    ]);
  });
});

describe("boxes the PDF itself groups", () => {
  test("are read as alternatives, and exactly one is turned on", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 200]);
    const status = doc.getForm().createRadioGroup("status");
    page.drawText("Single", { x: 60, y: 152, size: 10 });
    status.addOptionToPage("single", page, {
      x: 40,
      y: 150,
      width: 10,
      height: 10,
    });
    page.drawText("Married filing jointly", { x: 60, y: 122, size: 10 });
    status.addOptionToPage("married", page, {
      x: 40,
      y: 120,
      width: 10,
      height: 10,
    });
    const blank = await doc.save();

    const { targets } = await inspectPdf(blank);
    expect(targets).toMatchObject([
      { kind: "check", field: "status", option: "single", label: "Single" },
      {
        kind: "check",
        field: "status",
        option: "married",
        label: "Married filing jointly",
      },
    ]);
    const [single, married] = targets;
    const values = { [single.id]: false, [married.id]: true };
    const { bytes, omissions } = await fillPdf(blank, targets, values);
    expect(omissions).toEqual([]);
    expect(await verifyPdf(bytes, targets, values)).toEqual([]);
    // The other box is off: the check fails if we claim it's on.
    expect(await verifyPdf(bytes, targets, { [single.id]: true })).toEqual([
      { target: single.id, reason: "Not ticked." },
    ]);
    const filled = await PDFDocument.load(bytes);
    expect(filled.getForm().getRadioGroup("status").getSelected()).toBe(
      "married",
    );
  });
});
