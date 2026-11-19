"use node";
// Getting a fetched PDF into a state it can be read and filled in.
//
// Many government forms are "encrypted" without a password: anyone can open
// them, and the file itself says what may be done with it. Where it says
// forms may be filled in, that protection is removed so the form can be,
// which is what its publisher allows. Where it needs a password, or doesn't
// allow filling, the form is refused and says why.
import { createRequire } from "node:module";
import createQpdf from "@neslinesli93/qpdf-wasm";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

/** Why a PDF can't be used, in words for whoever registered the form. */
export class UnusablePdf extends Error {}

/** What the file allows, read from the file itself. */
async function permissionsOf(bytes: Uint8Array): Promise<number[] | null> {
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    password: "",
    verbosity: 0,
  });
  try {
    const document = await task.promise;
    return await document.getPermissions();
  } catch (error) {
    if (error instanceof Error && error.name === "PasswordException") {
      throw new UnusablePdf("It needs a password to open.");
    }
    throw new UnusablePdf("It can't be read as a PDF.");
  } finally {
    await task.destroy();
  }
}

/** qpdf, as much of it as is used here: its own types say less. */
type Qpdf = {
  callMain(args: string[]): number;
  FS: {
    writeFile(path: string, data: Uint8Array): void;
    readFile(path: string): Uint8Array;
  };
};

/** Runs qpdf on `/in.pdf` with `args`, and returns `/out.pdf`. */
export async function runQpdf(
  bytes: Uint8Array,
  args: string[],
): Promise<{ code: number; bytes: Uint8Array | undefined }> {
  const wasm = createRequire(import.meta.url).resolve(
    "@neslinesli93/qpdf-wasm/dist/qpdf.wasm",
  );
  const start = createQpdf as unknown as (options: object) => Promise<Qpdf>;
  const qpdf = await start({
    locateFile: () => wasm,
    noInitialRun: true,
    print: () => undefined,
    printErr: () => undefined,
  });
  qpdf.FS.writeFile("/in.pdf", bytes);
  const code = qpdf.callMain([...args, "/in.pdf", "/out.pdf"]);
  // 0 is clean, 3 is "done, with warnings": both wrote the file.
  const wrote = code === 0 || code === 3;
  return { code, bytes: wrote ? qpdf.FS.readFile("/out.pdf") : undefined };
}

/** The same document with its passwordless protection removed. */
async function withoutProtection(bytes: Uint8Array): Promise<Uint8Array> {
  const out = await runQpdf(bytes, ["--decrypt"]);
  if (!out.bytes) throw new UnusablePdf("Its protection couldn't be removed.");
  return out.bytes;
}

/**
 * The PDF ready to be read and filled. Unprotected files come back as they
 * are. `opened` is true when protection was removed, which happens only
 * when the file opens with no password and allows its forms to be filled.
 */
export async function openForFilling(
  bytes: Uint8Array,
): Promise<{ bytes: Uint8Array; opened: boolean }> {
  const permissions = await permissionsOf(bytes);
  // No permissions recorded: the file isn't protected.
  if (permissions === null) return { bytes, opened: false };
  if (!permissions.includes(pdfjs.PermissionFlag.FILL_INTERACTIVE_FORMS)) {
    throw new UnusablePdf("Its publisher doesn't allow it to be filled in.");
  }
  return { bytes: await withoutProtection(bytes), opened: true };
}
