import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Effect, Layer } from "effect";
import { runControllerOperation } from "@grokbox/runtime-kernel/commands";
import { sha256Text, canonicalJson } from "@grokbox/runtime-kernel/hash";
import {
  ControlResources,
  type ControllerReceipt,
  type ControllerRequest,
  type FrozenControllerCommand,
  type LeaseDecision,
  type OperationRecord,
} from "@grokbox/runtime-kernel/ports";
import { parseDesiredFile, parseModelsFile } from "@grokbox/runtime-kernel/selection";
import { desiredPath, modelsPath, reviewedProfilePath } from "../io/paths.ts";

export const liveMutationAttempts = { signal: 0, spawn: 0, guardian: 0 };

export function resetLiveMutationAttempts(): void {
  liveMutationAttempts.signal = 0;
  liveMutationAttempts.spawn = 0;
  liveMutationAttempts.guardian = 0;
}

export function controllerOperationId(intent: "apply" | "reconcile", boxRoot: string): string {
  return sha256Text(canonicalJson({ intent, boxRoot }));
}

type StoreFile = Record<string, OperationRecord>;

function storePath(boxRoot: string): string {
  return join(boxRoot, "state", "controller-operations.json");
}

function loadStore(boxRoot: string): StoreFile {
  try {
    return JSON.parse(readFileSync(storePath(boxRoot), "utf8")) as StoreFile;
  } catch {
    return {};
  }
}

function saveStore(boxRoot: string, store: StoreFile): void {
  const path = storePath(boxRoot);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(store)}\n`, { mode: 0o600 });
}

/** Inspect durable facts. Never authorizes live mutation. */
export function inspectControllerFacts(boxRoot: string): { ok: boolean; reason: string | null; strategy?: "direct" | "transient" } {
  try {
    if (!existsSync(desiredPath(boxRoot))) return { ok: false, reason: "missing-desired" };
    const desired = parseDesiredFile(JSON.parse(readFileSync(desiredPath(boxRoot), "utf8")));
    if (!existsSync(modelsPath(boxRoot))) return { ok: false, reason: "missing-models" };
    parseModelsFile(JSON.parse(readFileSync(modelsPath(boxRoot), "utf8")));
    if (!existsSync(reviewedProfilePath(boxRoot))) return { ok: false, reason: "missing-source" };
    if (desired.mode === "disabled") return { ok: false, reason: "desired-disabled" };
    return { ok: false, reason: "live-not-proven", strategy: desired.mode === "route" ? "transient" : "direct" };
  } catch {
    return { ok: false, reason: "preflight-invalid" };
  }
}

export function liveControlResourcesLayer(): Layer.Layer<ControlResources> {
  return Layer.succeed(ControlResources, {
    lease: (input: FrozenControllerCommand) => Effect.acquireRelease(
      Effect.sync(() => {
        const store = loadStore(input.boxRoot);
        const existing = store[input.operationId];
        let decision: LeaseDecision = { status: "acquired" };
        if (existing) {
          if (existing.fingerprint !== input.fingerprint) decision = { status: "conflict" };
          else if (existing.state === "terminal") decision = { status: "duplicate" };
          else if (existing.state === "unknown") decision = { status: "uncertain" };
          else decision = { status: "busy" };
        } else {
          store[input.operationId] = { fingerprint: input.fingerprint, state: "running" };
          saveStore(input.boxRoot, store);
        }
        return { decision, boxRoot: input.boxRoot, operationId: input.operationId };
      }),
      (held) => Effect.sync(() => {
        if (held.decision.status !== "acquired") return;
        const store = loadStore(held.boxRoot);
        const existing = store[held.operationId];
        if (existing && existing.state === "running") {
          store[held.operationId] = { ...existing, state: "unknown" };
          saveStore(held.boxRoot, store);
        }
      }),
    ).pipe(Effect.map((held) => held.decision)),
    peek: (input: { operationId: string; boxRoot: string }) => Effect.sync(() => {
      return loadStore(input.boxRoot)[input.operationId] ?? null;
    }),
    settle: (input: { operationId: string; boxRoot: string; state: "unknown" | "terminal" }) => Effect.sync(() => {
      const store = loadStore(input.boxRoot);
      const existing = store[input.operationId];
      if (existing) {
        store[input.operationId] = { ...existing, state: input.state };
        saveStore(input.boxRoot, store);
      }
    }),
    preflight: (input: FrozenControllerCommand) => Effect.sync(() => inspectControllerFacts(input.boxRoot)),
    recheck: (input: FrozenControllerCommand) => Effect.sync(() => inspectControllerFacts(input.boxRoot)),
    signal: (_input: FrozenControllerCommand) => Effect.sync(() => {
      liveMutationAttempts.signal += 1;
      return { signaled: false };
    }),
    spawn: (_input: FrozenControllerCommand) => Effect.sync(() => {
      liveMutationAttempts.spawn += 1;
      return { spawned: false };
    }),
    armGuardian: (_input: FrozenControllerCommand) => Effect.sync(() => {
      liveMutationAttempts.guardian += 1;
      return { guardian: false };
    }),
    wait: (_input: FrozenControllerCommand) => Effect.void,
    commit: (_input: FrozenControllerCommand) => Effect.succeed({ committed: false }),
  });
}

export async function startControlOperation(request: ControllerRequest): Promise<ControllerReceipt> {
  return Effect.runPromise(
    Effect.scoped(runControllerOperation(request).pipe(Effect.provide(liveControlResourcesLayer()))),
  );
}
