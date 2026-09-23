import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { CONT_NATIVE_PAIR, nativeContinuityCode } from "../native-continuity-code.ts";
import { sha256Bytes } from "@grokbox/runtime-kernel/hash";
import { continuityStorePolicy } from "@grokbox/runtime-kernel/continuity";
import { captureNativeCheckpoint, verifyNativeCheckpointReadback } from "../../src/internal/host/native-checkpoint.ts";

// Test-only transport into the ORIGINAL blob worker and AgentStore. Only the
// marked owned source.db is reachable; no live Bot, manager or Provider runs here.
const [directory, entry, mode] = process.argv.slice(2);
if (!directory || !entry || !["write", "read"].includes(mode ?? "")
  || readFileSync(join(directory, "owned-marker"), "utf8") !== "grokbox-original-worker") throw Error("unowned_model_checkpoint");
const agentId = "11111111-1111-4111-8111-111111111111", slot = new TextEncoder().encode("owned-model-pipeline-slot");
const policy = continuityStorePolicy(), n = nativeContinuityCode();
const worker = new Worker(entry, { workerData: { fixtureRoot: directory, agentId, blobDbPath: join(directory, "source.db"), busyTimeoutMs: 1000 },
  stdout: true, stderr: true, execArgv: [] });
let next = 1, ended = false;
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
const stop = () => { ended = true; for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Error("owned_native_worker_closed")); } pending.clear(); };
worker.stdout?.resume(); worker.stderr?.resume(); worker.on("error", stop); worker.on("exit", stop);
worker.on("message", value => {
  const p = pending.get(value.requestId); if (!p) return; pending.delete(value.requestId); clearTimeout(p.timer);
  if (value.kind === "error") p.reject(Error("owned_native_worker_rejected")); else p.resolve(value);
});
function call(body: object): Promise<any> {
  if (ended) return Promise.reject(Error("owned_native_worker_closed"));
  const requestId = next++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(requestId); reject(Error("owned_native_worker_timeout")); void worker.terminate(); }, 10000);
    pending.set(requestId, { resolve, reject, timer }); worker.postMessage({ ...body, requestId });
  });
}
try {
  if ((await call({ kind: "init" })).grokboxCheckpointProtocol !== 1) throw Error("owned_native_protocol");
  const readBlob = async (id: Uint8Array, maxBytes: number): Promise<Uint8Array | undefined> => {
    const data = (await call({ kind: "get-blob", blobId: id })).blobData as Uint8Array | undefined;
    if (data && data.byteLength > maxBytes) throw Error("owned_native_blob_budget"); return data;
  };
  const store = new n.AgentStore({
    getBlob: (_ctx: unknown, id: Uint8Array) => readBlob(id, policy.maxPartBytes),
    setBlob: async (_ctx: unknown, id: Uint8Array, data: Uint8Array) => { await call({ kind: "set-blob", blobId: id, blobData: data }); },
  }, { get: (key: string) => key === "latestRootBlobId" ? slot : agentId,
    set: (key: string, value: Uint8Array) => { if (key !== "latestRootBlobId" || sha256Bytes(value) !== sha256Bytes(slot)) throw Error("owned_native_metadata"); } }, { fixedRootBlobId: slot });
  let rootHash: string;
  if (mode === "write") {
    const input = readFileSync(0); if (input.length > 1024 * 1024) throw Error("owned_native_input_budget");
    const messages: unknown = JSON.parse(input.toString("utf8")); if (!Array.isArray(messages) || messages.length > 200) throw Error("owned_native_input_shape");
    const ids: Uint8Array[] = [];
    for (const message of messages) {
      const data = new TextEncoder().encode(JSON.stringify(message)), id = Uint8Array.from(Buffer.from(sha256Bytes(data), "hex"));
      await call({ kind: "set-blob", blobId: id, blobData: data }); ids.push(id);
    }
    const nativeRoot = new n.ConversationStateStructure({ rootPromptMessagesJson: ids });
    await store.handleCheckpoint({}, nativeRoot); rootHash = sha256Bytes(nativeRoot.toBinary());
  } else {
    const receipt = JSON.parse(readFileSync(join(directory, "checkpoint-receipt.json"), "utf8"));
    if (receipt.host !== CONT_NATIVE_PAIR.host || receipt.worker !== CONT_NATIVE_PAIR.worker || !/^[a-f0-9]{64}$/.test(receipt.rootHash)) throw Error("owned_native_receipt_identity");
    rootHash = receipt.rootHash;
  }
  const readback = await verifyNativeCheckpointReadback({ store, ctx: {}, expectedRootHash: rootHash,
    maxBytes: policy.maxPartBytes, readBlob });
  const material = await captureNativeCheckpoint({ schema: { root: n.ConversationStateStructure,
    referenceTypes: n.BLOB_REFERENCE_MESSAGE_TYPE_BY_NAME, referenceMetadata: n.getBlobReferenceMessageMetadata, isMessage: n.isMessage },
    reader: { rootId: slot, readBlob }, expected: { agentId, scopeId: "a".repeat(64), hostSourceSha: CONT_NATIVE_PAIR.host,
      nativeSchema: CONT_NATIVE_PAIR.schema, hostGeneration: "owned-pipeline", contextRevision: "b".repeat(64), activationEpoch: "owned-epoch",
      rootHash, state: "prepared", effects: "clear" }, policy, capturedAtMs: 1 });
  const receipt = { host: CONT_NATIVE_PAIR.host, worker: CONT_NATIVE_PAIR.worker, rootHash, parts: material.manifest.parts.map(p => ({ id: p.id, hash: p.hash })) };
  if (mode === "write") writeFileSync(join(directory, "checkpoint-receipt.json"), JSON.stringify(receipt), { mode: 0o600 });
  else if (JSON.stringify(receipt) !== readFileSync(join(directory, "checkpoint-receipt.json"), "utf8")) throw Error("owned_native_closure_changed");
  const messages = await Promise.all(store.getConversationStateStructure().rootPromptMessagesJson.map(async (id: Uint8Array) => {
    const data = await readBlob(id, policy.maxPartBytes); if (!data) throw Error("owned_native_leaf_missing"); return JSON.parse(Buffer.from(data).toString("utf8"));
  }));
  await call({ kind: "close" }); await worker.terminate();
  console.log(JSON.stringify({ pid: process.pid, mode, rootHash, parts: receipt.parts.length,
    nativeStateReadBack: readback.nativeStateReadBack, originalWorker: true, nativeSqlite: true,
    ...(mode === "read" ? { messages } : {}), fullHostExecuted: false, providerRequests: 0 }));
} finally { await worker.terminate(); }
