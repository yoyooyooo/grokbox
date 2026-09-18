import { mkdir, open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { canonicalJson, sha256Bytes, sha256Text } from "@grokbox/runtime-kernel/hash";
import { CurrentStateFailure, initializationDigest, sameCurrentHead, type InitializationAttempt, type InitializeCurrentRequest,
  type NativeApplicationMarker, type NativeApplicationObservation, type NativeCurrentHead, type NativeCurrentStatePort,
  type NativeMaterial, type PreparedCurrentState } from "@grokbox/runtime-kernel/continuity";
import { buildHostEnvelope } from "../../src/internal/host/context-codec.ts";

export const CURRENT_SCOPE = "a".repeat(64), CURRENT_POLICY = "b".repeat(64), CURRENT_SHA = "f".repeat(64);
export const SOURCE_AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", TARGET_AGENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
type Message = { role: "system" | "user" | "assistant"; content: string };
type DiskState = { head: NativeCurrentHead; messages: Message[]; memory: string; marker: NativeApplicationMarker | null };
export type CurrentStateHooks = {
  afterSourceRead?: (material: NativeMaterial) => Promise<void>;
  beforeSourceHead?: () => Promise<void>;
  beforeTargetHead?: () => Promise<void>;
  beforeCommit?: () => Promise<void>;
  afterCommit?: () => Promise<void>;
  afterPrepare?: () => Promise<void>;
  onRelease?: () => Promise<void>;
  afterReopen?: (head: NativeCurrentHead) => NativeCurrentHead;
  application?: (value: NativeApplicationObservation) => NativeApplicationObservation;
};
/** Owned synthetic native boundary, NOT private Host source or a qualified
 * production importer. Real files exercise the production coordinator/store;
 * only this fixture understands the synthetic root encoding below. */
export async function ownedCurrentState(directory: string, hooks: CurrentStateHooks = {}) {
  const sourceFile = join(directory, "source.json"), targetFile = join(directory, "target.json");
  const calls: string[] = [];
  async function save(file: string, value: unknown) {
    const handle = await open(`${file}.next`, "w", 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
    await rename(`${file}.next`, file);
  }
  const read = async (file: string): Promise<DiskState> => JSON.parse(await readFile(file, "utf8"));
  const materialFrom = (source: DiskState): NativeMaterial => {
    const rows = [
      { id: "fixed-root-slot", kind: "native-root" as const, dependencies: ["history"], bytes: new TextEncoder().encode(JSON.stringify({ messagePart: "history" })) },
      { id: "history", kind: "native-blob" as const, dependencies: [], bytes: new TextEncoder().encode(JSON.stringify(source.messages)) },
      { id: "memory", kind: "agent-memory" as const, dependencies: [], bytes: new TextEncoder().encode(source.memory) },
    ];
    const parts = rows.map(r => ({ id: r.id, kind: r.kind, dependencies: r.dependencies, hash: sha256Bytes(r.bytes), bytes: r.bytes.length }));
    return { manifest: { version: 1, source: { agentId: source.head.agentId, scopeId: CURRENT_SCOPE,
      contextRevision: source.head.contextRevision, nativeSchema: "owned-current-v1", capturedAtMs: 1700000000000, transcriptThrough: 3 },
      quality: "native_checkpoint", root: "fixed-root-slot", gaps: source.head.effects === "unresolved" ? ["unknown_effects"] : [], parts },
      content: new Map(rows.map((r, i) => [parts[i]!.hash, r.bytes])) };
  };
  const baseHead = (agentId: string): NativeCurrentHead => ({ agentId, scopeId: CURRENT_SCOPE, hostSourceSha: CURRENT_SHA,
    nativeSchema: "owned-current-v1", hostGeneration: "fixture-host-1", activationEpoch: "epoch-0", contextRevision: sha256Text(`empty:${agentId}`),
    rootHash: null, state: "empty", effects: "clear" });
  async function seed() {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const source: DiskState = { head: { ...baseHead(SOURCE_AGENT), state: "active", contextRevision: sha256Text("source-checkpoint-1") },
      messages: [{ role: "system", content: "OLD_SYSTEM_IDENTITY" }, { role: "user", content: "EARLY_FACT_SENTINEL" },
        { role: "assistant", content: "CONFIRMED_WORK_SENTINEL" }], memory: "SOURCE_MEMORY_SENTINEL", marker: null };
    source.head.rootHash = materialFrom(source).manifest.parts[0]!.hash;
    await save(sourceFile, source);
    await save(targetFile, { head: baseHead(TARGET_AGENT), messages: [], memory: "TARGET_MEMORY_UNCHANGED", marker: null } satisfies DiskState);
  }
  async function observation(attempt: InitializationAttempt): Promise<NativeApplicationObservation> {
    const current = await read(targetFile);
    const value: NativeApplicationObservation = current.marker?.operationId === attempt.operationId
      ? { state: "applied", marker: current.marker, current: current.head }
      : { state: "absent", current: current.head };
    return hooks.application ? hooks.application(value) : value;
  }
  const native: NativeCurrentStatePort = {
    qualification: { hostSourceSha: CURRENT_SHA, nativeSchema: "owned-current-v1" },
    capture: async () => {
      calls.push("capture.acquire");
      return { readHead: async () => { await hooks.beforeSourceHead?.(); return (await read(sourceFile)).head; },
        readMaterial: async () => { calls.push("capture.read"); const m = materialFrom(await read(sourceFile)); await hooks.afterSourceRead?.(m); return m; },
        release: async () => { calls.push("capture.release"); await hooks.onRelease?.(); } };
    },
    initialize: async attempt => {
      calls.push("target.acquire");
      const prior = await read(targetFile);
      if (!sameCurrentHead(prior.head, attempt.expected)) throw new CurrentStateFailure("source_changed");
      let prepared: PreparedCurrentState | undefined, next: DiskState | undefined, attempted = false;
      return {
        readHead: async () => { await hooks.beforeTargetHead?.(); return (await read(targetFile)).head; },
        prepare: async (material, operation) => {
          calls.push("target.prepare");
          if (material.manifest.source.nativeSchema !== "owned-current-v1" || material.manifest.quality !== "native_checkpoint") throw new CurrentStateFailure("material_invalid");
          const root = material.manifest.parts.find(p => p.id === material.manifest.root)!;
          const decoded = JSON.parse(new TextDecoder().decode(material.content.get(root.hash)!));
          const history = material.manifest.parts.find(p => p.id === decoded.messagePart);
          if (!history) throw new CurrentStateFailure("material_invalid");
          const messages = JSON.parse(new TextDecoder().decode(material.content.get(history.hash)!)) as Message[];
          // Synthetic decoder replaces current system identity, never history
          // attribution. Import is current-context-only; Memory stays separate.
          const installed: Message[] = [{ role: "system", content: `TARGET_SYSTEM:${TARGET_AGENT}` }, ...messages.filter(m => m.role !== "system")];
          buildHostEnvelope(installed); // Use the actual production window codec.
          const rootHash = sha256Text(JSON.stringify(installed)), candidateHash = sha256Text(canonicalJson([operation.inputDigest, installed]));
          prepared = { rootHash, candidateHash, inputDigest: operation.inputDigest };
          const head: NativeCurrentHead = { ...prior.head, state: "prepared", contextRevision: sha256Text(`applied:${rootHash}`), rootHash, activationEpoch: "epoch-1" };
          const marker: NativeApplicationMarker = { version: 1, operationId: operation.operationId, effectId: operation.effectId,
            agentId: TARGET_AGENT, scopeId: CURRENT_SCOPE, inputDigest: operation.inputDigest, snapshotRevision: operation.snapshot.revision,
            candidateHash, rootHash, contextRevision: head.contextRevision, nativeSchema: "owned-current-v1" };
          next = { ...prior, head, messages: installed, marker };
          await hooks.afterPrepare?.();
          return { ...prepared };
        },
        commit: async (operation, candidate) => {
          if (attempted || !prepared || !next || canonicalJson(candidate) !== canonicalJson(prepared)
            || operation.inputDigest !== attempt.inputDigest) throw new CurrentStateFailure("commit_unknown");
          attempted = true; calls.push("target.commit"); await hooks.beforeCommit?.();
          if (!sameCurrentHead((await read(targetFile)).head, attempt.expected)) throw new CurrentStateFailure("source_changed");
          await save(targetFile, next); await hooks.afterCommit?.();
        },
        reopen: async () => { calls.push("target.reopen"); const head = (await read(targetFile)).head; return hooks.afterReopen ? hooks.afterReopen(head) : head; },
        application: observation,
        release: async disposition => { calls.push(`target.release:${disposition}`); await hooks.onRelease?.(); },
      };
    },
    observeApplication: async attempt => { calls.push("target.observe"); return observation(attempt); },
  };
  return { native, calls, seed, directory, sourceFile, targetFile,
    source: async () => read(sourceFile), target: async () => read(targetFile),
    sourceMaterial: async () => materialFrom(await read(sourceFile)),
    writeSource: (state: DiskState) => save(sourceFile, state), writeTarget: (state: DiskState) => save(targetFile, state),
    advance: async () => {
      const value = await read(targetFile); value.messages.push({ role: "assistant", content: "NEW_B2_WORK_SENTINEL" });
      value.head = { ...value.head, state: "active", rootHash: sha256Text(JSON.stringify(value.messages)), contextRevision: sha256Text("B2-progress"), activationEpoch: "epoch-2" };
      await save(targetFile, value);
    },
    envelope: async (text: string) => buildHostEnvelope([...(await read(targetFile)).messages, { role: "user", content: text }]),
    request: async (snapshot: InitializeCurrentRequest["snapshot"]): Promise<InitializeCurrentRequest> => ({ operationId: randomUUID(), effectId: randomUUID(),
      snapshot, expected: (await read(targetFile)).head, policyRevision: CURRENT_POLICY }),
    authorize: async (request: InitializeCurrentRequest) => ({ allowed: true, agentId: request.expected.agentId, scopeId: request.expected.scopeId,
      operationId: request.operationId, policyRevision: request.policyRevision, hostGeneration: request.expected.hostGeneration,
      observedAtMs: Date.now(), ownership: "confirmed_box" as const }),
  };
}
