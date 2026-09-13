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

export class HostSelectionUnavailableError extends Error {
  readonly code = "runtime_config_invalid";
  constructor() {
    super("Model selection is unavailable; no model was selected.");
    this.name = "HostSelectionUnavailableError";
  }
}

/** One models.json snapshot for identity and capacity. A verified absence of an
 * override selects official; unreadable state is not an official selection. */
export function captureHostManagedSelection(root: string, agentId?: string): HostManagedCapture {
  // Dedicated native summary sessions are outside per-Agent routing altogether.
  if (!agentId) return { kind: "official" };
  const file = loadModelsFileSync(root);
  if (!file) throw new HostSelectionUnavailableError();
  const captured = captureManagedSelection(file, agentId);
  if (captured.kind !== "managed" || !agentId) return { kind: "official" };
  const record = modelForAgent(file, agentId);
  if (!record) throw new HostSelectionUnavailableError();
  if (computeSelectionRevision({ agentId, model: record }) !== captured.selectionRevision) throw new HostSelectionUnavailableError();
  return { ...captured, record };
}

/** Keep native recovery markers pending while its startup/recreate owner still
 * withholds execution. Native resume-ownership already retries pending markers
 * after releasing its barrier; this helper never starts a retry or grants work.
 * Unknown configuration must not launch a resume that can lose its checkpoint. */
export function deferManagedHostResume(root: string, agentId: unknown, localWorkAllowed: unknown): boolean {
  if (localWorkAllowed === true) return false;
  if (typeof agentId !== "string" || !agentId) return true;
  try { return captureHostManagedSelection(root, agentId).kind === "managed"; }
  catch { return true; }
}

/** Thin Host capture. Uncovered agents stay official; no credential values. */
export function captureHostSelection(root: string, agentId?: string): CapturedSelection {
  const captured = captureHostManagedSelection(root, agentId);
  if (captured.kind !== "managed") return { kind: "official" };
  return { kind: "managed", modelId: captured.modelId, selectionRevision: captured.selectionRevision, assignment: captured.assignment };
}
