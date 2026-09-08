import { BackendFailure } from "@grokbox/runtime-kernel/contract";
import type { BackendKind } from "@grokbox/runtime-kernel/selection";

const KINDS: readonly BackendKind[] = ["echo", "openai-chat", "openai-responses"];

/** Exact kind lookup. Unknown kinds fail closed. No accepts scan or fallback. */
export function lookupBackendKind(kind: string): BackendKind {
  if ((KINDS as readonly string[]).includes(kind)) return kind as BackendKind;
  throw new BackendFailure("unknown_backend_kind");
}

export function lookupBackend<T>(kind: string, table: Record<BackendKind, T>): T {
  const resolved = lookupBackendKind(kind);
  const found = table[resolved];
  if (found === undefined) throw new BackendFailure("unknown_backend_kind");
  return found;
}
