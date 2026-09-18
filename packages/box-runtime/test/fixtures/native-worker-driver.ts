import { Worker } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { sha256Bytes } from "@grokbox/runtime-kernel/hash";
import { continuityStorePolicy, recoveryRevision } from "@grokbox/runtime-kernel/continuity";
import { CONT_NATIVE_PAIR, nativeContinuityCode } from "../native-continuity-code.ts";

const [root, entry] = process.argv.slice(2);
if (!root || !entry || readFileSync(join(root, "owned-marker"), "utf8") !== "grokbox-original-worker") throw Error("unowned_test");
const n = nativeContinuityCode(), policy = continuityStorePolicy(), scopeId = "a".repeat(64);
const text = (value: string) => new TextEncoder().encode(value), slot = text("owned-native-slot");
const ids = { source: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", target: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
const children: Worker[] = [];
async function connection(which: "source" | "target") {
  const worker = new Worker(entry!, { workerData: { fixtureRoot: root, agentId: ids[which], blobDbPath: join(root!, `${which}.db`), busyTimeoutMs: 1000 },
    stdout: true, stderr: true, execArgv: [] }); children.push(worker);
  let stderr = "", next = 1;
  worker.stderr?.on("data", c => { stderr = (stderr + String(c)).slice(-4096); });
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  worker.on("message", response => {
    const value = pending.get(response.requestId); if (!value) return;
    pending.delete(response.requestId); clearTimeout(value.timer);
    if (response.kind === "error") value.reject(Error(response.message)); else value.resolve(response);
  });
  const die = () => { for (const value of pending.values()) { clearTimeout(value.timer); value.reject(Error(`owned-worker-closed:${stderr}`)); } pending.clear(); };
  worker.on("error", die); worker.on("exit", die);
  const call = (body: object): Promise<any> => {
    const requestId = next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(Error("owned-worker-timeout")); void worker.terminate(); }, 15000);
      pending.set(requestId, { resolve, reject, timer }); worker.postMessage({ ...body, requestId });
    });
  };
  const hello = await call({ kind: "init" }); if (hello.grokboxCheckpointProtocol !== 1) throw Error("worker-protocol-not-advertised");
  return { call, close: async () => { await call({ kind: "close" }); await worker.terminate(); },
    current: async (action: string, payload: unknown) => (await call({ kind: "grokbox-current-state", version: 1, action, payload })).result };
}
function expect(condition: unknown, label: string): asserts condition { if (!condition) throw Error(label); }
try {
  const source = await connection("source");
  const leaf = text(JSON.stringify({ role: "user", content: "ORIGINAL_WORKER_FACT" })), leafId = Uint8Array.from(Buffer.from(sha256Bytes(leaf), "hex"));
  const rootState = new n.ConversationStateStructure({ rootPromptMessagesJson: [leafId] });
  await source.call({ kind: "set-blob", blobId: leafId, blobData: leaf });
  await source.call({ kind: "set-blob", blobId: slot, blobData: rootState.toBinary() });
  const sourceHead = { agentId: ids.source, scopeId, hostSourceSha: CONT_NATIVE_PAIR.host, nativeSchema: CONT_NATIVE_PAIR.schema,
    hostGeneration: "owned-driver", contextRevision: "d".repeat(64), activationEpoch: "owned-epoch", rootHash: sha256Bytes(rootState.toBinary()), state: "prepared", effects: "clear" };
  const material = await source.current("capture", { expected: sourceHead, rootId: slot, limits: policy, capturedAtMs: 1 });
  expect(material.manifest.parts.length === 2, "worker-capture-closure");
  await source.close();
  const target = await connection("target"), expected = { ...sourceHead, agentId: ids.target, rootHash: null, state: "empty" };
  const attempt = { operationId: randomUUID(), effectId: randomUUID(), policyRevision: "e".repeat(64), expected,
    snapshot: { owner: "continuity.recovery", ref: randomUUID(), revision: recoveryRevision(material.manifest) } };
  const candidate = await target.current("prepare", { attempt, rootId: slot, material }); expect(candidate.state === "candidate", "prepare-read-only");
  const before = await target.call({ kind: "get-blob", blobId: slot }); expect(before.blobData === undefined, "prepare-did-not-write");
  const result = await target.current("apply", { attempt, rootId: slot, material });
  expect(result.state === "worker_committed" && result.nativeApplicationComplete === false, "worker-only-commit");
  let blocked = false;
  try { await target.call({ kind: "collect-garbage", retainedRootIdHex: Buffer.from(slot).toString("hex"), pendingWriteRetentionMs: 0 }); } catch { blocked = true; }
  expect(blocked, "held-marker-fences-original-gc");
  const [capture, observed] = await Promise.all([
    target.current("capture", { expected: { ...expected, rootHash: result.marker.rootHash, state: "prepared" }, rootId: slot, limits: policy, capturedAtMs: 1 }),
    target.current("observe", { attempt }),
  ]);
  expect(capture.manifest.parts.length === 2 && observed.marker.inputDigest === result.marker.inputDigest, "serialized-capture-and-receipt");
  await target.close();
  const reopened = await connection("target");
  const proof = await reopened.current("observe", { attempt }); expect(proof.marker.rootHash === sourceHead.rootHash, "receipt-survives-native-worker-restart");
  blocked = false; try { await reopened.call({ kind: "set-blob", blobId: slot, blobData: text("unexpected") }); } catch { blocked = true; }
  expect(blocked, "persistent-hold-after-restart");
  await reopened.current("release", { attempt, rootId: slot });
  const later = new n.ConversationStateStructure({ rootPromptMessagesJson: [leafId], selfSummaryCount: 7 }).toBinary();
  await reopened.call({ kind: "set-blob", blobId: slot, blobData: later });
  const retry = await reopened.current("apply", { attempt, rootId: slot, material }); expect(retry.duplicate, "same-operation-does-not-reapply");
  expect(sha256Bytes((await reopened.call({ kind: "get-blob", blobId: slot })).blobData) === sha256Bytes(later), "B2-not-overwritten");
  await reopened.close();
  console.log(JSON.stringify({ originalWorker: true, nativeSqlite: true, protocol: 1, prepareReadOnly: true,
    durableReceipt: true, persistentGcFence: true, b2Preserved: true, startedBot: false, providerRequests: 0 }));
} finally { await Promise.all(children.map(w => w.terminate())); }
