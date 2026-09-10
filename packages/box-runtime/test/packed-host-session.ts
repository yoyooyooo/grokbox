/**
 * Source session constructors by default.
 * When GROKBOX_PACKED_SESSION_FACTORY=1, load constructors from dist/preload.cjs.
 * Never enable with GROKBOX_ALLOW_LIVE_HOST=1.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PACKED_SESSION_SYMBOL } from "../src/internal/host/profile.ts";
import {
  asHostPromptSession as sourceAsHostPromptSession,
  createStreamingPromptSession as sourceCreateStreamingPromptSession,
  InvalidHostStateError as sourceInvalidHostStateError,
  type HostPromptSession,
  type StreamPart,
} from "../src/internal/host/session.ts";

const require = createRequire(import.meta.url);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

export type PackedHostSessionApi = {
  asHostPromptSession: typeof sourceAsHostPromptSession;
  createStreamingPromptSession: typeof sourceCreateStreamingPromptSession;
  InvalidHostStateError: typeof sourceInvalidHostStateError;
};

export function loadPackedHostSessionApi(): PackedHostSessionApi {
  if (process.env.GROKBOX_PACKED_SESSION_FACTORY !== "1") {
    return {
      asHostPromptSession: sourceAsHostPromptSession,
      createStreamingPromptSession: sourceCreateStreamingPromptSession,
      InvalidHostStateError: sourceInvalidHostStateError,
    };
  }
  if (process.env.GROKBOX_ALLOW_LIVE_HOST === "1") {
    throw new Error("packed session factory refused while GROKBOX_ALLOW_LIVE_HOST=1");
  }
  const packed = process.env.GROKBOX_PACKED_PRELOAD ?? join(repoRoot, "dist", "preload.cjs");
  require(packed);
  const api = (globalThis as Record<symbol, PackedHostSessionApi | undefined>)[Symbol.for(PACKED_SESSION_SYMBOL)];
  if (!api?.asHostPromptSession || !api?.createStreamingPromptSession || !api?.InvalidHostStateError) {
    throw new Error("packed session factory missing");
  }
  return api;
}

const packedHostSession = loadPackedHostSessionApi();
export const asHostPromptSession = packedHostSession.asHostPromptSession;
export const createStreamingPromptSession = packedHostSession.createStreamingPromptSession;
export const InvalidHostStateError = packedHostSession.InvalidHostStateError;
export type { HostPromptSession, StreamPart };
