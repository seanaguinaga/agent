// @vitest-environment node
// How well a flat page is read, scored against the truth. Each form here is
// a real fillable government PDF. Flattened, it's a real flat one whose
// right answers we know: the blanks should be where the fields were.
import { readFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
import { expect, test } from "vitest";
import { inspectPdf, type Target } from "./pdf";

const FORMS = ["f8822", "fw9", "f8821", "f2848"] as const;

/**
 * Whether text written into the region lands where the field is: on the same
 * baseline, across most of the field's width. A region may be taller than
 * the field (the whole cell, not just its bottom line) and still be right.
 */
const lands = (field: Target, region: Target) => {
  const across =
    Math.min(field.x + field.w, region.x + region.w) -
    Math.max(field.x, region.x);
  return (
    Math.abs(region.y - field.y) <= 3 &&
    across >= 0.8 * field.w &&
    region.w <= field.w * 1.5 + 10
  );
};
/** Words that say what a place is for, not dots, arrows or a lone number. */
const meaningful = (label: string) => /[A-Za-z]{3,}/.test(label);
const share = (part: number, whole: number) =>
  whole ? Math.round((100 * part) / whole) : 100;

type Score = {
  form: string;
  fields: number;
  /** % of text fields with a blank found where they were. */
  textFound: number;
  /** % of tick boxes found. */
  boxesFound: number;
  /** Blanks found per field: over 100 means extras. */
  regionsPerField: number;
  /** % of fields whose printed label says something. */
  fieldLabels: number;
  /** % of found blanks whose label says something. */
  regionLabels: number;
};

async function score(form: string): Promise<Score> {
  const bytes = new Uint8Array(
    readFileSync(new URL(`./fixtures/${form}.pdf`, import.meta.url)),
  );
  const fillable = await inspectPdf(bytes);
  const doc = await PDFDocument.load(bytes, { parseSpeed: Infinity });
  doc.getForm().flatten();
  const flat = await inspectPdf(await doc.save({ objectsPerTick: Infinity }));
  const found = (kind: Target["kind"]) => {
    const fields = fillable.targets.filter((t) => t.kind === kind);
    const hit = fields.filter((field) =>
      flat.targets.some(
        (region) =>
          region.page === field.page &&
          region.kind === kind &&
          lands(field, region),
      ),
    );
    return share(hit.length, fields.length);
  };
  return {
    form,
    fields: fillable.targets.length,
    textFound: found("text"),
    boxesFound: found("check"),
    regionsPerField: share(flat.targets.length, fillable.targets.length),
    fieldLabels: share(
      fillable.targets.filter((t) => meaningful(t.label)).length,
      fillable.targets.length,
    ),
    regionLabels: share(
      flat.targets.filter((t) => meaningful(t.label)).length,
      flat.targets.length,
    ),
  };
}

/**
 * Where the reader stands, as measured. These are floors, not goals: a
 * change that drops below one has made the reader worse on a real form.
 *
 *            text  boxes
 *   f8822     95%  100%   the form the reader was first built against
 *   fw9       67%  100%   misses the single-digit TIN boxes
 *   f8821     88%  100%
 *   f2848     86%  100%
 *
 * Tick boxes are found everywhere. Text blanks are weakest where a form
 * uses one small box per character. About a quarter to a half more blanks
 * are found than there are fields: signature lines, and some printed cells.
 */
const FLOORS: Record<(typeof FORMS)[number], { text: number; boxes: number }> =
  {
    f8822: { text: 90, boxes: 100 },
    fw9: { text: 60, boxes: 100 },
    f8821: { text: 85, boxes: 100 },
    f2848: { text: 80, boxes: 100 },
  };

test.each(FORMS)(
  "%s, flattened: its blanks are found where its fields were",
  async (form) => {
    const got = await score(form);
    expect(got.textFound).toBeGreaterThanOrEqual(FLOORS[form].text);
    expect(got.boxesFound).toBeGreaterThanOrEqual(FLOORS[form].boxes);
    // Not so many extras that a reviewer drowns in them.
    expect(got.regionsPerField).toBeLessThanOrEqual(170);
    // Most blanks say what they're for.
    expect(got.regionLabels).toBeGreaterThanOrEqual(60);
  },
);
