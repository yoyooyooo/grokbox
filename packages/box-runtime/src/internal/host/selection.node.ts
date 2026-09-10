import { closeSync, constants as fsConstants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_READ_MAX_BYTES } from "@grokbox/runtime-kernel/contract";
import {
  captureManagedSelection, computeSelectionRevision, modelForAgent, parseModelsFile,
  type CapturedSelection, type ModelRecord, type ModelsFile,
} from "@grokbox/runtime-kernel/selection";

/** Bounded no-follow nonblocking regular-file read for preload/hook. Never mkdir or repair. */
export function loadModelsFileSync(root: string): ModelsFile | null {
  let fd: number | undefined;
  try {
    fd = openSync(join(root, "models.json"), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > CONFIG_READ_MAX_BYTES) return null;
    const bytes = Buffer.alloc(CONFIG_READ_MAX_BYTES + 1);
    const n = readSync(fd, bytes, 0, bytes.length, 0);
    if (n > CONFIG_READ_MAX_BYTES) return null;
    return parseModelsFile(JSON.parse(bytes.subarray(0, n).toString("utf8")));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
  }
}

export type HostManagedCapture =
  | { kind: "official" }
  | { kind: "managed"; modelId: string; selectionRevision: string; assignment: "agent"; record: ModelRecord };

/** One models.json snapshot for capture identity and Host capacity. Uncovered agents stay official. */
export function captureHostManagedSelection(root: string, agentId?: string): HostManagedCapture {
  const file = loadModelsFileSync(root);
  if (!file) return { kind: "official" };
  const captured = captureManagedSelection(file, agentId);
  if (captured.kind !== "managed" || !agentId) return { kind: "official" };
  const record = modelForAgent(file, agentId);
  if (!record) return { kind: "official" };
  if (computeSelectionRevision({ agentId, model: record }) !== captured.selectionRevision) return { kind: "official" };
  return { ...captured, record };
}

/** Thin Host capture. Uncovered agents stay official; no credential values. */
export function captureHostSelection(root: string, agentId?: string): CapturedSelection {
  const captured = captureHostManagedSelection(root, agentId);
  if (captured.kind !== "managed") return { kind: "official" };
  return { kind: "managed", modelId: captured.modelId, selectionRevision: captured.selectionRevision, assignment: captured.assignment };
}
