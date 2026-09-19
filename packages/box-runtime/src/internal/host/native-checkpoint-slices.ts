import type { SlicePatch } from "./profile.ts";

/** Finite methods on the existing worker/BlobStore, not a new worker pool or a
 * generic RPC tunnel. These do not initiate any reads/writes by themselves. */
export const NATIVE_CHECKPOINT_HOST_SLICES: readonly SlicePatch[] = [
  {
    id: "continuity-native-worker-handshake",
    startAnchor: "var AgentWorkerConnection = class {",
    endAnchor: "var DEFAULT_IDLE_TIMEOUT_MS =",
    find: "    this.workerThreadId = response.threadId;\n",
    replacement: "    this.grokboxCheckpointProtocol = response.grokboxCheckpointProtocol === 1 ? 1 : null;\n    this.workerThreadId = response.threadId;\n",
  },
  {
    id: "continuity-native-worker-client",
    startAnchor: "var AgentWorkerConnection = class {",
    endAnchor: "var DEFAULT_IDLE_TIMEOUT_MS =",
    find: "  async getBlob(blobId) {\n",
    replacement: `  async grokboxCurrentState(action, payload) {
    if (!["capture", "compose", "prepare", "apply", "observe", "release"].includes(action)) throw new Error("grokbox_checkpoint_action_invalid");
    if (this.grokboxCheckpointProtocol !== 1) throw new Error("grokbox_checkpoint_worker_unavailable");
    const response = await this.send(requestId => ({ kind: "grokbox-current-state", version: 1, requestId, action, payload }));
    if (response?.kind !== "grokbox-current-state-ok" || response.version !== 1) throw new Error("grokbox_checkpoint_worker_unavailable");
    return response.result;
  }
  async getBlob(blobId) {
`,
  },
  {
    id: "continuity-native-blob-owner",
    startAnchor: "var WorkerBlobStore = class {",
    endAnchor: "// src/host/extensions/session/session-store-factories.ts\nvar import_node_path136 =",
    find: "  async getBlob(_ctx, blobId) {\n",
    replacement: `  async grokboxCurrentState(action, payload) {
    if (!["capture", "compose", "prepare", "apply", "observe", "release"].includes(action)) throw new Error("grokbox_checkpoint_action_invalid");
    this.pool.retain(this.blobDbPath);
    try {
      const connection = await this.pool.ensure(this.agentId, this.blobDbPath, this.legacyBlobDbPath);
      if (typeof connection.grokboxCurrentState !== "function") throw new Error("grokbox_checkpoint_worker_unavailable");
      return await connection.grokboxCurrentState(action, payload);
    } finally {
      this.pool.release(this.blobDbPath);
    }
  }
  async getBlob(_ctx, blobId) {
`,
  },
];
