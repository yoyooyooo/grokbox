import Module from "node:module";
import { resolve } from "node:path";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import { NATIVE_CHECKPOINT_WORKER_SYMBOL, createNativeCheckpointWorkerDispatcher } from "./native-checkpoint-worker.ts";

/** Independent qualification of the worker ABI. Not the whole Host profile. */
import { NATIVE_CHECKPOINT_PAIR, nativeCheckpointPair } from "./native-checkpoint-pair.ts";
export { NATIVE_CHECKPOINT_PAIR } from "./native-checkpoint-pair.ts";
const open = '  port.on("message", (request) => {\n    try {\n      switch (request.kind) {';
const end = '  });\n}\nmain();\n';
/** Pure candidate authoring for the exact independently inspected worker ABI.
 * The Host hash is a correlation input, NOT qualification. Only the installer
 * below can select an approved Host/worker pair. No path or runtime is opened. */
export function prepareNativeCheckpointWorkerCandidate(source: string, hostSourceSha: string) {
  if (!/^[a-f0-9]{64}$/.test(hostSourceSha) || sha256Text(source) !== NATIVE_CHECKPOINT_PAIR.worker || source.indexOf(open) < 0
    || source.indexOf(open) !== source.lastIndexOf(open) || !source.endsWith(end)) throw Error("native_checkpoint_worker_unqualified");
  return source.replace(open, '  const __grokbox_original_dispatch = (request) => {\n    try {\n      switch (request.kind) {')
    .replace('            kind: "init-ok",\n', '            kind: "init-ok",\n            grokboxCheckpointProtocol: 1,\n')
    .slice(0, -end.length) + `  };
  const __grokbox_factory = globalThis[Symbol.for("${NATIVE_CHECKPOINT_WORKER_SYMBOL}")];
  if (typeof __grokbox_factory !== "function") throw new Error("native_checkpoint_worker_binding_missing");
  const __grokbox_dispatch = __grokbox_factory({ store, agentId: boot.agentId,
    qualification: { hostSourceSha: "${hostSourceSha}", nativeSchema: "${NATIVE_CHECKPOINT_PAIR.schema}" },
    schema: { root: ConversationStateStructure, referenceTypes: BLOB_REFERENCE_MESSAGE_TYPE_BY_NAME,
      referenceMetadata: getBlobReferenceMessageMetadata, isMessage }
  }, __grokbox_original_dispatch, post);
  port.on("message", __grokbox_dispatch);
}
main();
`;
}
/** Production transformation accepts only an independently qualified tuple. */
export function transformNativeCheckpointWorker(source: string, hostSourceSha: string = NATIVE_CHECKPOINT_PAIR.host) {
  const pair = nativeCheckpointPair(hostSourceSha, sha256Text(source));
  if (!pair) throw Error("native_checkpoint_worker_unqualified");
  return prepareNativeCheckpointWorkerCandidate(source, pair.host);
}
/** Install only while compiling the qualified worker under an explicitly
 * selected continuity profile. This function does not start a worker or install
 * a global require hook on its own. */
export function installNativeCheckpointWorkerHook(input: { targetPath: string; hostSourceSha: string; enabled: boolean }) {
  if (!input.enabled || !nativeCheckpointPair(input.hostSourceSha)) return { restore() {}, installed: false };
  const targetPath = resolve(input.targetPath);
  const proto = Module.prototype as unknown as { _compile: (this: NodeModule, source: string, filename: string) => unknown };
  const original = proto._compile;
  function wrapped(this: NodeModule, source: string, filename: string): unknown {
    if (resolve(filename) !== targetPath) return original.call(this, source, filename);
    // Restore even when exact worker bytes or the existing dispatcher refuse.
    if (proto._compile === wrapped) proto._compile = original;
    const transformed = transformNativeCheckpointWorker(source, input.hostSourceSha);
    bindNativeCheckpointWorker();
    return original.call(this, transformed, filename);
  }
  proto._compile = wrapped;
  return { installed: true, restore() { if (proto._compile === wrapped) proto._compile = original; } };
}

export function bindNativeCheckpointWorker() {
  const target = globalThis as Record<symbol, unknown>, symbol = Symbol.for(NATIVE_CHECKPOINT_WORKER_SYMBOL);
  if (target[symbol] !== undefined && target[symbol] !== createNativeCheckpointWorkerDispatcher) throw Error("native_checkpoint_worker_binding_conflict");
  target[symbol] = createNativeCheckpointWorkerDispatcher;
}
