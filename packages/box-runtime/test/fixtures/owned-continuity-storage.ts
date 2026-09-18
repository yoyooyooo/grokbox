import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import type { ContinuityStorageOwner, OwnerMeasurement, ProtectedStorageRef, ReferenceReceipt } from "@grokbox/runtime-kernel/observation";

/** Contract fixture, NOT a native backup/importer. Real owned files and a single
 * domain lock exercise the adapter obligation. No Bot data, routing or deletion. */
export async function ownedContinuityStorage(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  type Bundle = { revision: string; files: string[]; lastReliable: boolean };
  type State = { bundles: Record<string, Bundle>; claims: Record<string, ProtectedStorageRef>;
    requests: Record<string, { digest: string; receipt: ReferenceReceipt }>;
    operations: Record<string, "commit_unknown" | "pending"> };
  const file = join(path, "owner.json");
  let tail = Promise.resolve();
  const locked = async <T>(run: () => Promise<T>): Promise<T> => {
    const previous = tail; let done!: () => void;
    tail = new Promise<void>(resolve => { done = resolve; });
    await previous; try { return await run(); } finally { done(); }
  };
  const load = async (): Promise<State> => JSON.parse(await readFile(file, "utf8"));
  const save = async (state: State) => {
    await writeFile(file + ".next", JSON.stringify(state), { mode: 0o600 }); await rename(file + ".next", file);
  };
  await save({ bundles: {}, claims: {}, requests: {}, operations: { "existing-operation": "commit_unknown" } });
  let hold: (() => Promise<void>) | undefined, holdGc: (() => Promise<void>) | undefined;
  let budget = 1024 * 1024, safetyCapacityBytes = 1024 * 1024, effects = 0, gcCalls = 0, mutations = 0;
  async function bytes(bundle: Bundle) { let n = 0; for (const name of bundle.files) n += (await stat(join(path, name))).size; return n; }
  const adapter: ContinuityStorageOwner = {
    owner: "continuity.recovery",
    measure: () => locked(async () => {
      const state = await load(), names = ["owner.json", ...Object.values(state.bundles).flatMap(b => b.files)];
      let logicalBytes = 0, protectedLogicalBytes = 0, reclaimableLogicalBytes = 0;
      const allocations: OwnerMeasurement["allocations"] = [];
      for (const name of names) {
        const st = await stat(join(path, name)); logicalBytes += st.size;
        allocations.push({ allocationId: sha256Text(`${st.dev}:${st.ino}`), allocatedBytes: st.blocks * 512 });
      }
      for (const [ref, bundle] of Object.entries(state.bundles)) {
        const count = await bytes(bundle);
        if (bundle.lastReliable || Object.values(state.claims).some(c => c.ref === ref && c.revision === bundle.revision)) protectedLogicalBytes += count;
        else reclaimableLogicalBytes += count;
      }
      return { owner: "continuity.recovery", observedAtMs: Date.now(), coverage: "complete", logicalBytes, protectedLogicalBytes,
        reclaimableLogicalBytes, allocations, blockedBy: Object.keys(state.claims).length ? ["active_reference"] : ["last_reliable_point"] };
    }),
    changeReference: change => locked(async () => {
      mutations++; const state = await load(), digest = sha256Text(canonicalJson(change)), prior = state.requests[change.requestId];
      const reply = (kind: ReferenceReceipt["state"], blockedBy: ReferenceReceipt["blockedBy"] = []): ReferenceReceipt => ({
        requestId: change.requestId, claimId: change.claimId, reference: change.reference, state: kind, blockedBy });
      if (prior) return prior.digest === digest ? prior.receipt : reply("conflict", ["conflict"]);
      const bundle = state.bundles[change.reference.ref];
      if (!bundle || bundle.revision !== change.reference.revision) return reply("conflict", ["conflict"]);
      if (change.action === "protect") {
        const protectedRefs = new Set([change.reference.ref, ...Object.values(state.claims).map(c => c.ref)]);
        const used = (await Promise.all(Object.entries(state.bundles).filter(([ref, b]) => b.lastReliable || protectedRefs.has(ref)).map(([, b]) => bytes(b)))).reduce((a, b) => a + b, 0);
        if (used > budget) return reply("blocked", ["capacity"]);
        if (state.claims[change.claimId] && canonicalJson(state.claims[change.claimId]) !== canonicalJson(change.reference)) return reply("conflict", ["conflict"]);
        await hold?.(); state.claims[change.claimId] = change.reference;
      } else {
        const claim = state.claims[change.claimId];
        if (claim && canonicalJson(claim) !== canonicalJson(change.reference)) return reply("conflict", ["conflict"]);
        delete state.claims[change.claimId];
      }
      const receipt = reply(change.action === "protect" ? "protected" : "released");
      state.requests[change.requestId] = { digest, receipt }; await save(state); return receipt;
    }),
    maintain: ({ maxItems }) => locked(async () => {
      gcCalls++; await holdGc?.(); const state = await load(); let reclaimedBytes = 0, removed = 0;
      for (const [ref, bundle] of Object.entries(state.bundles)) {
        if (removed >= maxItems || bundle.lastReliable || Object.values(state.claims).some(c => c.ref === ref && c.revision === bundle.revision)) continue;
        reclaimedBytes += await bytes(bundle);
        for (const name of bundle.files) await unlink(join(path, name));
        delete state.bundles[ref]; removed++;
      }
      await save(state);
      return { owner: "continuity.recovery", state: "maintained", reclaimedBytes, blockedBy: ["last_reliable_point", "effect_unknown"] };
    }),
  };
  return { adapter, file, readState: () => locked(load),
    add: (ref: string, lastReliable = false) => locked(async () => {
      const state = await load(), files = [`${ref}-root`, `${ref}-memory`, `${ref}-attachment`];
      for (const name of files) await writeFile(join(path, name), `PRIVATE_RECOVERY_CONTENT:${name}`, { mode: 0o600 });
      state.bundles[ref] = { revision: "r1", files, lastReliable }; await save(state);
      return { owner: "continuity.recovery" as const, ref, revision: "r1" };
    }),
    readBundle: (ref: string) => locked(async () => { const s = await load(); return Promise.all(s.bundles[ref]!.files.map(name => readFile(join(path, name), "utf8"))); }),
    protectBarrier: (hook?: () => Promise<void>) => { hold = hook; }, gcBarrier: (hook?: () => Promise<void>) => { holdGc = hook; },
    setBudget: (bytes: number) => { budget = bytes; }, setSafetyCapacity: (v: boolean) => { safetyCapacityBytes = v ? 1024 * 1024 : 0; },
    startEffect: (id: string) => locked(async () => {
      const state = await load();
      if (state.operations[id] || Buffer.byteLength(JSON.stringify({ ...state.operations, [id]: "pending" })) > safetyCapacityBytes) return { state: "blocked", effects };
      state.operations[id] = "pending"; await save(state); effects++; return { state: "started", effects };
    }),
    calls: () => ({ gcCalls, mutations, effects }),
  };
}
