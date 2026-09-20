import Module from "node:module";
import { resolve } from "node:path";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import { NATIVE_CHECKPOINT_WORKER_SYMBOL, createNativeCheckpointWorkerDispatcher } from "./native-checkpoint-worker.ts";

/** Independent qualification of the worker ABI. Not the whole Host profile. */
import { NATIVE_CHECKPOINT_PAIR } from "./native-checkpoint-pair.ts";
export { NATIVE_CHECKPOINT_PAIR } from "./native-checkpoint-pair.ts";
const open = '  port.on("message", (request) => {\n    try {\n      switch (request.kind) {';
const end = '  });\n}\nmain();\n';
/** Exact original worker transformed in memory. No private source is stored in
 * the repository, no runtime eval of user input and no path is opened here. */
export function transformNativeCheckpointWorker(source: string) {
  if (sha256Text(source) !== NATIVE_CHECKPOINT_PAIR.worker || source.indexOf(open) < 0
    || source.indexOf(open) !== source.lastIndexOf(open) || !source.endsWith(end)) throw Error("native_checkpoint_worker_unqualified");
  return source.replace(open, '  const __grokbox_original_dispatch = (request) => {\n    try {\n      switch (request.kind) {')
    .replace('            kind: "init-ok",\n', '            kind: "init-ok",\n            grokboxCheckpointProtocol: 1,\n')
    .slice(0, -end.length) + `  };
  const __grokbox_factory = globalThis[Symbol.for("${NATIVE_CHECKPOINT_WORKER_SYMBOL}")];
  if (typeof __grokbox_factory !== "function") throw new Error("native_checkpoint_worker_binding_missing");
  const __grokbox_dispatch = __grokbox_factory({ store, agentId: boot.agentId,
    qualification: { hostSourceSha: "${NATIVE_CHECKPOINT_PAIR.host}", nativeSchema: "${NATIVE_CHECKPOINT_PAIR.schema}" },
    schema: { root: ConversationStateStructure, referenceTypes: BLOB_REFERENCE_MESSAGE_TYPE_BY_NAME,
      referenceMetadata: getBlobReferenceMessageMetadata, isMessage }
  }, __grokbox_original_dispatch, post);
  port.on("message", __grokbox_dispatch);
}
main();
`;
}
/** Install only while compiling the qualified worker under an explicitly
 * selected continuity profile. This function does not start a worker or install
 * a global require hook on its own. */
export function installNativeCheckpointWorkerHook(input: { targetPath: string; hostSourceSha: string; enabled: boolean }) {
  if (!input.enabled || input.hostSourceSha !== NATIVE_CHECKPOINT_PAIR.host) return { restore() {}, installed: false };
  const targetPath = resolve(input.targetPath);
  const proto = Module.prototype as unknown as { _compile: (this: NodeModule, source: string, filename: string) => unknown };
  const original = proto._compile;
  function wrapped(this: NodeModule, source: string, filename: string): unknown {
    if (resolve(filename) !== targetPath) return original.call(this, source, filename);
    const transformed = transformNativeCheckpointWorker(source);
    bindNativeCheckpointWorker();
    if (proto._compile === wrapped) proto._compile = original;
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
