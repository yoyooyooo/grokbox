import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
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
  type OperationPrefix,
  type OperationRecord,
} from "@grokbox/runtime-kernel/ports";
import { parseDesiredFile, parseModelsFile } from "@grokbox/runtime-kernel/selection";
import { expectedCompileReceipt, compileReceiptAgrees, type CompileReceipt } from "../host/compile-receipt.ts";
import { parseCoordinatorState } from "../io/coordinator-state.ts";
import { acquireExclusiveLock } from "../io/op-lock.ts";
import { coordinatorStatePath, desiredPath, modelsPath, reviewedProfilePath } from "../io/paths.ts";
import { parseReviewedProfile } from "../process/profile.node.ts";

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
const RECORD_STATES = new Set(["reserved", "running", "unknown", "terminal"]);
const HEX64 = /^[a-f0-9]{64}$/;

function storePath(boxRoot: string): string {
  return join(boxRoot, "state", "controller-operations.json");
}

function lockPath(boxRoot: string): string {
  return join(boxRoot, "state", "controller-operations.lock");
}

function parsePrefix(value: unknown): OperationPrefix | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.signaled !== "boolean" || typeof row.spawned !== "boolean" || typeof row.guardian !== "boolean") {
    return undefined;
  }
  return { signaled: row.signaled, spawned: row.spawned, guardian: row.guardian };
}

function parseStore(raw: string): { ok: true; store: StoreFile } | { ok: false } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false };
  const store: StoreFile = {};
  for (const [id, rec] of Object.entries(parsed as Record<string, unknown>)) {
    if (!id || !rec || typeof rec !== "object" || Array.isArray(rec)) return { ok: false };
    const row = rec as Record<string, unknown>;
    if (typeof row.fingerprint !== "string" || row.fingerprint.length === 0) return { ok: false };
    if (typeof row.state !== "string" || !RECORD_STATES.has(row.state)) return { ok: false };
    store[id] = {
      fingerprint: row.fingerprint,
      state: row.state as OperationRecord["state"],
      ...(parsePrefix(row.prefix) ? { prefix: parsePrefix(row.prefix) } : {}),
    };
  }
  return { ok: true, store };
}

function loadStore(boxRoot: string): { ok: true; store: StoreFile } | { ok: false; reason: "store-corrupt" } {
  const path = storePath(boxRoot);
  if (!existsSync(path)) return { ok: true, store: {} };
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { ok: false, reason: "store-corrupt" };
  }
  const parsed = parseStore(raw);
  if (!parsed.ok) return { ok: false, reason: "store-corrupt" };
  return parsed;
}

function saveStore(boxRoot: string, store: StoreFile): void {
  const path = storePath(boxRoot);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(store)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

function readOptionalJson(path: string): { present: false } | { present: true; value: unknown } | { present: true; invalid: true } {
  if (!existsSync(path)) return { present: false };
  try {
    return { present: true, value: JSON.parse(readFileSync(path, "utf8")) };
  } catch {
    return { present: true, invalid: true };
  }
}

/** Inspect durable facts. Never authorizes live mutation. */
export function inspectControllerFacts(boxRoot: string): { ok: boolean; reason: string | null; strategy?: "direct" | "transient" } {
  try {
    if (!existsSync(desiredPath(boxRoot))) return { ok: false, reason: "missing-desired" };
    const desired = parseDesiredFile(JSON.parse(readFileSync(desiredPath(boxRoot), "utf8")));
    if (!existsSync(modelsPath(boxRoot))) return { ok: false, reason: "missing-models" };
    parseModelsFile(JSON.parse(readFileSync(modelsPath(boxRoot), "utf8")));
    if (!existsSync(reviewedProfilePath(boxRoot))) return { ok: false, reason: "missing-source" };
    let profileJson: unknown;
    try {
      profileJson = JSON.parse(readFileSync(reviewedProfilePath(boxRoot), "utf8"));
    } catch {
      return { ok: false, reason: "invalid-source" };
    }
    let profile;
    try {
      profile = parseReviewedProfile(profileJson);
    } catch {
      return { ok: false, reason: "unreviewed-profile" };
    }
    if (!HEX64.test(profile.sourceSha256) || !HEX64.test(profile.transformedSourceSha256)) {
      return { ok: false, reason: "invalid-compile" };
    }
    const compilePath = join(boxRoot, "state", "compile-receipt.json");
    const compile = readOptionalJson(compilePath);
    if (compile.present) {
      if ("invalid" in compile) return { ok: false, reason: "compile-mismatch" };
      const expected = expectedCompileReceipt(profile);
      if (!compileReceiptAgrees(compile.value as CompileReceipt, expected)) {
        return { ok: false, reason: "compile-mismatch" };
      }
    }
    const coordinator = readOptionalJson(coordinatorStatePath(boxRoot));
    if (coordinator.present) {
      if ("invalid" in coordinator) return { ok: false, reason: "identity-invalid" };
      try {
        parseCoordinatorState(coordinator.value);
      } catch {
        return { ok: false, reason: "identity-invalid" };
      }
    }
    if (desired.mode === "disabled") return { ok: false, reason: "desired-disabled" };
    return { ok: false, reason: "live-not-proven", strategy: desired.mode === "route" ? "transient" : "direct" };
  } catch {
    return { ok: false, reason: "preflight-invalid" };
  }
}

export function liveControlResourcesLayer(): Layer.Layer<ControlResources> {
  return Layer.succeed(ControlResources, {
    lease: (input: FrozenControllerCommand) => Effect.acquireRelease(
      Effect.tryPromise(async () => {
        const locked = await acquireExclusiveLock(lockPath(input.boxRoot));
        if (!locked.ok) {
          return { decision: { status: "busy" as const } satisfies LeaseDecision, lock: null, boxRoot: input.boxRoot, operationId: input.operationId };
        }
        const loaded = loadStore(input.boxRoot);
        if (!loaded.ok) {
          await locked.lock.release();
          return { decision: { status: "corrupt" as const } satisfies LeaseDecision, lock: null, boxRoot: input.boxRoot, operationId: input.operationId };
        }
        const existing = loaded.store[input.operationId];
        let decision: LeaseDecision = { status: "acquired" };
        if (existing) {
          if (existing.fingerprint !== input.fingerprint) decision = { status: "conflict" };
          else if (existing.state === "terminal") decision = { status: "duplicate" };
          else if (existing.state === "unknown") decision = { status: "uncertain" };
          else decision = { status: "busy" };
        } else {
          loaded.store[input.operationId] = { fingerprint: input.fingerprint, state: "running" };
          saveStore(input.boxRoot, loaded.store);
        }
        if (decision.status !== "acquired") {
          await locked.lock.release();
          return { decision, lock: null, boxRoot: input.boxRoot, operationId: input.operationId };
        }
        return { decision, lock: locked.lock, boxRoot: input.boxRoot, operationId: input.operationId };
      }),
      (held) => Effect.promise(async () => {
        if (!held.lock) return;
        try {
          const loaded = loadStore(held.boxRoot);
          if (loaded.ok) {
            const existing = loaded.store[held.operationId];
            if (existing && existing.state === "running") {
              loaded.store[held.operationId] = { ...existing, state: "unknown" };
              saveStore(held.boxRoot, loaded.store);
            }
          }
        } finally {
          await held.lock.release();
        }
      }),
    ).pipe(Effect.map((held) => held.decision)),
    peek: (input: { operationId: string; boxRoot: string }) => Effect.try({
      try: () => {
        const loaded = loadStore(input.boxRoot);
        if (!loaded.ok) throw new Error("store-corrupt");
        return loaded.store[input.operationId] ?? null;
      },
      catch: (error) => error,
    }),
    settle: (input: { operationId: string; boxRoot: string; state: "running" | "unknown" | "terminal"; prefix?: OperationPrefix }) => Effect.try({
      try: () => {
        const loaded = loadStore(input.boxRoot);
        if (!loaded.ok) throw new Error("store-corrupt");
        const existing = loaded.store[input.operationId];
        if (existing) {
          loaded.store[input.operationId] = { ...existing, state: input.state, prefix: input.prefix ?? existing.prefix };
          saveStore(input.boxRoot, loaded.store);
        }
      },
      catch: (error) => error,
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
