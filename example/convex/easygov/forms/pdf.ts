"use node";
// Reading, filling and checking a PDF form. Pure: bytes in, bytes or facts
// about them out. No Convex here, so it's tested against a real form.
//
// A form is a list of targets: places a value can go. On a fillable PDF they
// are its fields. On a flat one they are found on the page: the space above
// a ruled line, a small square. From there on the two are treated alike.
import {
  PDFCheckBox,
  PDFDocument,
  PDFName,
  PDFRadioGroup,
  PDFTextField,
  StandardFonts,
  type PDFFont,
} from "pdf-lib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

// pdf-lib pauses on a timer every so many objects. A form is small, and a
// timer is one more thing to wait on: read and write in one go.
const LOAD = { ignoreEncryption: true, parseSpeed: Infinity };

export type Target = {
  /** Stable within an edition: "p1.f3" for a field, "p1.r3" for a region. */
  id: string;
  /** From 1. */
  page: number;
  /** In PDF points, from the page's bottom left. */
  x: number;
  y: number;
  w: number;
  h: number;
  kind: "text" | "check";
  source: "field" | "region";
  /** The PDF's own name for a field. */
  field?: string;
  /**
   * For a box the PDF groups with others under one field (a radio group, or
   * a tick box with several boxes): the value that turns this one on. Only
   * one box of the group can be ticked.
   */
  option?: string;
  /** The words printed beside it: what the form is asking for. */
  label: string;
  maxLength?: number;
};

export type Inspection = {
  pages: number;
  /** The revision printed on the form, e.g. "Rev. February 2021". */
  edition?: string;
  /** False for a flat PDF: its targets were found on the page. */
  fillable: boolean;
  targets: Target[];
  /** Each page's words, in order: empty where a page has none to read. */
  words: string[];
  /** True for a form drawn only by XFA: its words are read from there. */
  xfa: boolean;
};

type Text = { str: string; x: number; y: number; w: number; h: number };
type Rect = { x: number; y: number; w: number; h: number };
type PageMarks = {
  text: Text[];
  /** Ruled lines: [x1, y, x2]. */
  rules: [number, number, number][];
  /** Vertical lines: [x, y1, y2]. */
  dividers: [number, number, number][];
  boxes: Rect[];
};

const round = (n: number) => Math.round(n * 10) / 10;

// --- Reading a page's marks -------------------------------------------------

type Matrix = [number, number, number, number, number, number];
const multiply = (m: Matrix, n: number[]): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = (m: Matrix, x: number, y: number): [number, number] => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5],
];

/** The text and the drawn lines of each page, in page coordinates. */
async function readMarks(
  bytes: Uint8Array,
): Promise<{ marks: PageMarks[]; xfa: boolean }> {
  const pdf = await pdfjs.getDocument({
    // pdfjs takes ownership of the buffer it's given.
    data: bytes.slice(),
    useSystemFonts: true,
    // A form drawn only by XFA shows a "please wait" page: its words are
    // then read from its XFA template and data, as the pages they make.
    enableXfa: true,
    verbosity: 0,
  }).promise;
  const { OPS } = pdfjs;
  const pages: PageMarks[] = [];
  for (let number = 1; number <= pdf.numPages; number++) {
    const page = await pdf.getPage(number);
    const content = await page.getTextContent();
    const text: Text[] = [];
    for (const item of content.items) {
      if (!("str" in item) || !item.str.trim()) continue;
      // Words read from XFA have no place on a page.
      const [, , , , x = 0, y = 0] = (item.transform ?? []) as number[];
      text.push({
        str: item.str,
        x,
        y,
        w: item.width ?? 0,
        h: item.height ?? 0,
      });
    }
    const ops = await page.getOperatorList();
    let ctm: Matrix = [1, 0, 0, 1, 0, 0];
    const stack: Matrix[] = [];
    const strokes: [[number, number], [number, number]][] = [];
    const boxes: Rect[] = [];
    let pending: typeof strokes = [];
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i];
      const args = ops.argsArray[i];
      if (fn === OPS.save) stack.push(ctm);
      else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
      else if (fn === OPS.transform) ctm = multiply(ctm, args);
      else if (fn === OPS.constructPath) {
        const [kinds, coords] = args as [number[], number[]];
        let c = 0;
        let at: [number, number] | undefined;
        let start: [number, number] | undefined;
        for (const kind of kinds) {
          if (kind === OPS.moveTo) {
            at = start = apply(ctm, coords[c++], coords[c++]);
          } else if (kind === OPS.lineTo) {
            const to = apply(ctm, coords[c++], coords[c++]);
            if (at) pending.push([at, to]);
            at = to;
          } else if (kind === OPS.rectangle) {
            const [x, y] = apply(ctm, coords[c], coords[c + 1]);
            const w = coords[c + 2] * ctm[0];
            const h = coords[c + 3] * ctm[3];
            c += 4;
            boxes.push({
              x: Math.min(x, x + w),
              y: Math.min(y, y + h),
              w: Math.abs(w),
              h: Math.abs(h),
            });
          } else if (kind === OPS.curveTo) c += 6;
          else if (kind === OPS.curveTo2 || kind === OPS.curveTo3) c += 4;
          else if (kind === OPS.closePath && at && start) {
            pending.push([at, start]);
            at = start;
          }
        }
      } else if (
        fn === OPS.stroke ||
        fn === OPS.closeStroke ||
        fn === OPS.fillStroke ||
        fn === OPS.closeFillStroke
      ) {
        strokes.push(...pending);
        pending = [];
      } else if (fn === OPS.fill || fn === OPS.eoFill || fn === OPS.endPath) {
        pending = [];
      }
    }
    const rules: PageMarks["rules"] = [];
    const dividers: PageMarks["dividers"] = [];
    for (const [a, b] of strokes) {
      if (Math.abs(a[1] - b[1]) < 0.5 && Math.abs(a[0] - b[0]) > 20) {
        rules.push([Math.min(a[0], b[0]), a[1], Math.max(a[0], b[0])]);
      } else if (Math.abs(a[0] - b[0]) < 0.5 && Math.abs(a[1] - b[1]) > 5) {
        dividers.push([a[0], Math.min(a[1], b[1]), Math.max(a[1], b[1])]);
      }
    }
    pages.push({ text, rules, dividers, boxes });
  }
  return { marks: pages, xfa: pdf.isPureXfa };
}

const overlap = (a1: number, a2: number, b1: number, b2: number) =>
  Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));

// --- Labels -----------------------------------------------------------------

const LABEL_MAX = 140;
const join = (items: Text[]) =>
  items
    .sort((a, b) => (Math.abs(a.y - b.y) > 3 ? b.y - a.y : a.x - b.x))
    .map((item) => item.str.trim())
    .join(" ")
    .replace(/\s+/g, " ")
    .slice(0, LABEL_MAX);

/** The words printed beside a target: what the form asks for there. */
function labelOf(
  rect: Rect,
  kind: Target["kind"],
  { text, rules }: PageMarks,
): string {
  const top = rect.y + rect.h;
  const right = rect.x + rect.w;
  if (kind === "check") {
    // A tick box is labelled by what follows it on its line.
    const after = text.filter(
      (t) =>
        t.x >= right - 1 &&
        t.x - right < 260 &&
        t.y > rect.y - 4 &&
        t.y < top + 2,
    );
    if (after.length) return join(after);
  }
  // A caption sits just above where the answer goes, and may run to two
  // lines. It ends at the ruled line that closes the cell: beyond that is
  // the row above.
  const ceiling = Math.min(
    ...rules
      .filter(
        ([x1, y, x2]) =>
          y > top - 1 && overlap(rect.x, right, x1, x2) > rect.w / 2,
      )
      .map(([, y]) => y),
    top + 12,
  );
  const caption = text.filter(
    (t) =>
      t.x >= rect.x - 2 && t.x < right && t.y >= top - 3 && t.y < ceiling - 1,
  );
  if (caption.length) return join(caption);
  // Otherwise, whatever is on the same line to its left.
  const before = text
    .filter((t) => t.x + t.w <= rect.x + 4 && t.y > rect.y - 4 && t.y < top + 2)
    .sort((a, b) => b.x - a.x)
    .slice(0, 6);
  return join(before);
}

// --- Finding blanks on a flat page ------------------------------------------

/** A square small enough to be a tick box. */
const isTickBox = ({ w, h }: Rect) =>
  w >= 5 && w <= 14 && h >= 5 && h <= 14 && Math.abs(w - h) < 2;

function findRegions(marks: PageMarks): { rect: Rect; kind: Target["kind"] }[] {
  const found: { rect: Rect; kind: Target["kind"] }[] = [];
  // Tick boxes: drawn as rectangles, or as two short uprights a box apart.
  const ticks = marks.boxes.filter(isTickBox);
  for (const [x, y1, y2] of marks.dividers) {
    const pair = marks.dividers.find(
      ([x2, b1, b2]) =>
        x2 > x &&
        Math.abs(x2 - x - (y2 - y1)) < 2 &&
        Math.abs(b1 - y1) < 1 &&
        Math.abs(b2 - y2) < 1,
    );
    const box = pair && { x, y: y1, w: pair[0] - x, h: y2 - y1 };
    if (box && isTickBox(box)) ticks.push(box);
  }
  for (const box of ticks) {
    const seen = found.some(
      ({ rect }) =>
        Math.abs(rect.x - box.x) < 2 && Math.abs(rect.y - box.y) < 2,
    );
    if (!seen) found.push({ rect: box, kind: "check" });
  }

  // Text blanks: the space above a ruled line, up to the next rule or the
  // caption printed in it, and between any uprights that divide it.
  const rules = marks.rules
    .filter(
      (rule, i, all) =>
        all.findIndex(
          (other) =>
            Math.abs(other[1] - rule[1]) < 0.5 &&
            Math.abs(other[0] - rule[0]) < 1 &&
            Math.abs(other[2] - rule[2]) < 1,
        ) === i,
    )
    .sort((a, b) => a[1] - b[1]);
  for (const [x1, y, x2] of rules) {
    const above = rules
      .filter(
        (rule) =>
          rule[1] > y + 6 && overlap(x1, x2, rule[0], rule[2]) > (x2 - x1) / 2,
      )
      .map((rule) => rule[1]);
    const ceiling = Math.min(...above, y + 40);
    // Cut at uprights that cross the cell.
    const cuts = marks.dividers
      .filter(
        ([x, d1, d2]) =>
          x > x1 + 4 && x < x2 - 4 && overlap(y, ceiling, d1, d2) > 5,
      )
      .map(([x]) => x)
      .sort((a, b) => a - b);
    const edges = [
      x1,
      ...cuts.filter((x, i) => x - (cuts[i - 1] ?? x1) > 4),
      x2,
    ];
    for (let i = 0; i + 1 < edges.length; i++) {
      const left = edges[i];
      const right = edges[i + 1];
      const inside = marks.text.filter(
        (t) =>
          t.x >= left - 1 && t.x < right - 2 && t.y >= y + 1 && t.y < ceiling,
      );
      // The answer goes below the lowest printed line in the cell.
      const floor = Math.min(...inside.map((t) => t.y - 1), ceiling);
      const height = floor - y;
      if (height < 8 || right - left < 20) continue;
      // Skip cells that are printed full: headings, instructions.
      const printed = inside.reduce((sum, t) => sum + t.str.trim().length, 0);
      if (printed > (right - left) / 2 && height < 12) continue;
      const rect = { x: left, y, w: right - left, h: height };
      // The same cell is often ruled twice.
      const twice = found.some(
        ({ rect: other }) =>
          Math.abs(other.x - rect.x) < 2 &&
          Math.abs(other.y - rect.y) < 2 &&
          Math.abs(other.w - rect.w) < 3,
      );
      if (!twice) found.push({ rect, kind: "text" });
    }
  }
  return found.filter(
    ({ rect, kind }) =>
      kind === "check" ||
      !found.some(
        (other) =>
          other.kind === "check" &&
          overlap(
            rect.x,
            rect.x + rect.w,
            other.rect.x,
            other.rect.x + other.rect.w,
          ) >
            other.rect.w / 2 &&
          Math.abs(other.rect.y - rect.y) < 2 &&
          rect.w < 16,
      ),
  );
}

// --- Inspecting -------------------------------------------------------------

/** What a PDF form is: its edition, and every place a value can go. */
export async function inspectPdf(bytes: Uint8Array): Promise<Inspection> {
  const { marks, xfa } = await readMarks(bytes);
  const doc = await PDFDocument.load(bytes, LOAD);
  const pages = doc.getPages();
  const edition = marks
    .flatMap((page) => page.text.map((t) => t.str))
    .join(" ")
    .match(/\((Rev\.[^)]{3,40})\)/)?.[1];
  const targets: Target[] = [];
  const counts: Record<number, number> = {};
  const add = (
    page: number,
    rect: Rect,
    target: Pick<Target, "kind" | "source" | "field" | "maxLength" | "option">,
  ) => {
    const n = (counts[page] = (counts[page] ?? 0) + 1);
    targets.push({
      id: `p${page}.${target.source === "field" ? "f" : "r"}${n}`,
      page,
      x: round(rect.x),
      y: round(rect.y),
      w: round(rect.w),
      h: round(rect.h),
      label: labelOf(
        rect,
        target.kind,
        marks[page - 1] ?? { text: [], rules: [], dividers: [], boxes: [] },
      ),
      ...target,
    });
  };

  const fields = doc.getForm().getFields();
  for (const field of fields) {
    const kind =
      field instanceof PDFTextField
        ? "text"
        : field instanceof PDFCheckBox || field instanceof PDFRadioGroup
          ? "check"
          : undefined;
    // Dropdowns and list boxes aren't handled yet: they're left alone.
    if (!kind) continue;
    const widgets = field.acroField.getWidgets();
    // Several boxes under one field are alternatives: each has the value
    // that turns it on.
    const options =
      field instanceof PDFRadioGroup
        ? field.getOptions()
        : field instanceof PDFCheckBox && widgets.length > 1
          ? widgets.map((widget) => widget.getOnValue()?.decodeText())
          : undefined;
    widgets.forEach((widget, i) => {
      const ref = widget.P();
      const index = pages.findIndex((page) => page.ref === ref);
      if (index < 0) return;
      const { x, y, width, height } = widget.getRectangle();
      add(
        index + 1,
        { x, y, w: width, h: height },
        {
          kind,
          source: "field",
          field: field.getName(),
          option: options?.[i],
          maxLength:
            field instanceof PDFTextField ? field.getMaxLength() : undefined,
        },
      );
    });
  }
  const fillable = targets.length > 0;
  if (!fillable) {
    marks.forEach((page, i) => {
      const regions = findRegions(page).sort(
        (a, b) => b.rect.y - a.rect.y || a.rect.x - b.rect.x,
      );
      for (const { rect, kind } of regions) {
        add(i + 1, rect, { kind, source: "region" });
      }
    });
  }
  const words = marks.map((page) => page.text.map((t) => t.str).join(" "));
  return { pages: marks.length, edition, fillable, targets, words, xfa };
}

// --- Filling ----------------------------------------------------------------

/** A value for a target: text to write, or whether to tick it. */
export type Values = Record<string, string | boolean>;

/** A value that wasn't written, and why. Never shortened to fit. */
export type Omission = { target: string; reason: string };

const PAD = 2;
const MAX_SIZE = 10;
const MIN_SIZE = 6;

/** The largest size at which the text fits the region on one line. */
function fitSize(font: PDFFont, text: string, target: Target) {
  for (let size = Math.min(MAX_SIZE, target.h - 3); size >= MIN_SIZE; size--) {
    if (font.widthOfTextAtSize(text, size) <= target.w - 2 * PAD) return size;
  }
  return undefined;
}

/**
 * Writes the values into the form. A field is set; a region is drawn into.
 * A value that doesn't fit its place is left out and reported, never cut
 * short: half an address is worse than none.
 */
export async function fillPdf(
  bytes: Uint8Array,
  targets: Target[],
  values: Values,
): Promise<{ bytes: Uint8Array; omissions: Omission[] }> {
  const doc = await PDFDocument.load(bytes, LOAD);
  const form = doc.getForm();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const omissions: Omission[] = [];
  for (const target of targets) {
    const value = values[target.id];
    if (value === undefined || value === "" || value === false) continue;
    const skip = (reason: string) =>
      omissions.push({ target: target.id, reason });
    if (target.kind === "check") {
      if (value !== true) {
        skip("A tick box takes yes or no.");
      } else if (target.field && target.option !== undefined) {
        selectOption(form.getField(target.field), target.option);
      } else if (target.field) {
        form.getCheckBox(target.field).check();
      } else {
        const size = target.h;
        doc.getPage(target.page - 1).drawText("X", {
          x: target.x + (target.w - font.widthOfTextAtSize("X", size)) / 2,
          y: target.y + (target.h - font.heightAtSize(size) * 0.72) / 2,
          size,
          font,
        });
      }
      continue;
    }
    if (typeof value !== "string") {
      skip("A text box takes text.");
    } else if (/[\n\r]/.test(value)) {
      skip("It has more than one line.");
    } else if (target.maxLength && value.length > target.maxLength) {
      skip(
        `It's longer than the ${target.maxLength} characters the box takes.`,
      );
    } else if (target.field) {
      form.getTextField(target.field).setText(value);
    } else {
      const size = fitSize(font, value, target);
      if (!size) {
        skip("It doesn't fit the space.");
        continue;
      }
      doc.getPage(target.page - 1).drawText(value, {
        x: target.x + PAD,
        y: target.y + 3,
        size,
        font,
      });
    }
  }
  return { bytes: await doc.save({ objectsPerTick: Infinity }), omissions };
}

/** Turns on one box of a group the PDF declares, and the others off. */
function selectOption(field: unknown, option: string) {
  if (field instanceof PDFRadioGroup) {
    field.select(option);
  } else if (field instanceof PDFCheckBox) {
    const on = PDFName.of(option);
    field.acroField.dict.set(PDFName.of("V"), on);
    for (const widget of field.acroField.getWidgets()) {
      const mine = widget.getOnValue()?.decodeText() === option;
      widget.setAppearanceState(mine ? on : PDFName.of("Off"));
    }
  }
}

/** The box of a declared group that's on, by its option, if any is. */
function selectedOption(field: unknown): string | undefined {
  if (field instanceof PDFRadioGroup) return field.getSelected();
  if (!(field instanceof PDFCheckBox)) return undefined;
  for (const widget of field.acroField.getWidgets()) {
    const on = widget.getOnValue()?.decodeText();
    if (on && widget.getAppearanceState()?.decodeText() === on) return on;
  }
  return undefined;
}

// --- Checking ---------------------------------------------------------------

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * Reads a filled form back and says what isn't as it should be: a field
 * whose value differs, or a region whose text isn't on the page inside it.
 * An empty list is the proof the document says what the person said.
 */
export async function verifyPdf(
  bytes: Uint8Array,
  targets: Target[],
  values: Values,
): Promise<Omission[]> {
  const problems: Omission[] = [];
  const doc = await PDFDocument.load(bytes, LOAD);
  const form = doc.getForm();
  const drawn = targets.some((target) => !target.field);
  const marks = drawn ? (await readMarks(bytes)).marks : [];
  for (const target of targets) {
    const want = values[target.id];
    if (want === undefined || want === "" || want === false) continue;
    const wrong = (reason: string) =>
      problems.push({ target: target.id, reason });
    if (target.field) {
      if (target.kind === "check") {
        const ticked =
          target.option !== undefined
            ? selectedOption(form.getField(target.field)) === target.option
            : form.getCheckBox(target.field).isChecked();
        if (!ticked) wrong("Not ticked.");
      } else if (form.getTextField(target.field).getText() !== want) {
        wrong("The field doesn't hold the value.");
      }
      continue;
    }
    const inside = (marks[target.page - 1]?.text ?? []).filter(
      (t) =>
        t.x >= target.x - 1 &&
        t.x + t.w <= target.x + target.w + 1 &&
        t.y >= target.y - 1 &&
        t.y <= target.y + target.h,
    );
    const found = squash(inside.map((t) => t.str).join(" "));
    const expected = want === true ? "X" : squash(want);
    if (!found.includes(expected)) wrong("The text isn't inside its space.");
  }
  return problems;
}
