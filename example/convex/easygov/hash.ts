// SHA-256, synchronously. `crypto.subtle` is async, and the functions that
// compare fingerprints (`case/state.ts`) are pure and sync.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

/** The SHA-256 of the text, as 64 hex characters. */
export function sha256Hex(text: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(text)));
}
