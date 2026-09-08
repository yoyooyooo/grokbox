import { boundedText, count, isRecord, observeJson } from "../io/observation.node.ts";
import { coordinatorStatePath } from "../io/paths.ts";

export type CoordinatorState = {
  version: 1;
  circuit: "closed" | "open";
  circuitReason?: string;
  mutationCount: number;
  attemptedKeys: string[];
  lastAttemptKey?: string;
};

export function parseCoordinatorState(value: unknown): CoordinatorState {
  if (!isRecord(value) || value.version !== 1 || (value.circuit !== "closed" && value.circuit !== "open") ||
    !count(value.mutationCount) || !Array.isArray(value.attemptedKeys) || value.attemptedKeys.length > 32 ||
    !value.attemptedKeys.every((key) => boundedText(key)) ||
    (value.circuitReason !== undefined && !boundedText(value.circuitReason)) ||
    (value.lastAttemptKey !== undefined && !boundedText(value.lastAttemptKey))) throw new Error("invalid coordinator state");
  return {
    version: 1, circuit: value.circuit, mutationCount: value.mutationCount, attemptedKeys: [...value.attemptedKeys],
    ...(value.circuitReason !== undefined ? { circuitReason: value.circuitReason as string } : {}),
    ...(value.lastAttemptKey !== undefined ? { lastAttemptKey: value.lastAttemptKey as string } : {}),
  };
}

export function observeCoordinatorState(root: string) {
  return observeJson(coordinatorStatePath(root), parseCoordinatorState);
}
