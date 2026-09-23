import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
export { canonicalJson } from "./canonical-json.ts";

/** Same UTF-8 SHA-256 identity as the Node implementation, without Node globals.
 * Kept separate so existing server hashing retains its original native backend. */
export function sha256Text(text: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(text)));
}
export function sha256Bytes(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}
