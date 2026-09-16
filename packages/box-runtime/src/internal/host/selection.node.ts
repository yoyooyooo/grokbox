import { homedir } from "node:os";
import { join } from "node:path";
import {
  captureManagedSelection, computeSelectionRevision, modelForAgent, parseModelsFile,
  resolveModelsWithPi,
  type CapturedSelection, type ModelRecord, type ModelsFile,
} from "@grokbox/runtime-kernel/selection";
import { readBoundedJsonSync } from "./bounded-json.node.ts";

/** Bounded no-follow nonblocking regular-file read for preload/hook. Never mkdir or repair. */
export function loadModelsFileSync(root: string): ModelsFile | null {
  try {
    const raw = readBoundedJsonSync(join(root, "models.json"));
    if (raw === undefined) return null;
    const native = parseModelsFile(raw);
    try {
      return resolveModelsWithPi(native, {
        homedir: homedir(),
        env: process.env,
        read: readBoundedJsonSync,
      });
    } catch (error) {
      if (error instanceof Error && error.message === "Pi models.json was not found for externalCatalog pi.") {
        return native;
      }
      throw error;
    }
  } catch {
    return null;
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
