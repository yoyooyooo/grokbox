import type { SlicePatch } from "./profile.ts";
import { NATIVE_CURRENT_STATE_SYMBOL } from "./native-current-state-owner.ts";
import { NATIVE_CHECKPOINT_PAIR } from "./native-checkpoint-worker-hook.ts";
const control = `globalThis[Symbol.for("${NATIVE_CURRENT_STATE_SYMBOL}")]`;

export const NATIVE_CURRENT_STATE_SLICES: readonly SlicePatch[] = [
  {
    id: "continuity-native-run-fence",
    startAnchor: "function createTurnRunShell(host) {",
    endAnchor: "var SandAgentRunner = class _SandAgentRunner {",
    find: "  async function run(prompt, options2 = {}) {\n",
    replacement: `  async function run(prompt, options2 = {}) {
    const __grokbox_current = ${control};
    const __grokbox_run = __grokbox_current?.wrapRun(host, __grokbox_native_run) ?? __grokbox_native_run;
    return await __grokbox_run(prompt, options2);
  }
  async function __grokbox_native_run(prompt, options2 = {}) {
`,
  },
  {
    id: "continuity-native-duplicate-identity",
    startAnchor: "function rewriteClonedAgentIdentity(targetDir, newAgentId, includesChatHistory, createAgentDb) {",
    endAnchor: "function copyIfPresent(sourcePath, targetPath) {",
    find: "    db.clearTransientState();\n",
    replacement: `    db.clearTransientState();
    db.deleteKv("grokbox.current-state.v1");
    if (db.readKv("grokbox.current-state.v1") !== null) throw new Error("grokbox_duplicate_fence_cleanup_failed");
`,
  },
  {
    id: "continuity-native-rpc-schema",
    startAnchor: "    getHostStatus: rpcMethod().args(hostStatusArgs),",
    endAnchor: "    setBoxMigrating: rpcMethod().args({ migrating: rpcBoolean() }),",
    find: "    getHostStatus: rpcMethod().args(hostStatusArgs),\n",
    replacement: "    getHostStatus: rpcMethod().args(hostStatusArgs),\n    grokboxCurrentStateControl: rpcMethod().args(rpcObject({ version: rpcNumber(), action: rpcString(), agentId: rpcString(), payload: rpcOptional(rpcString()), confirm: rpcOptional(rpcBoolean()) })),\n",
  },
  {
    id: "continuity-native-rpc-api",
    startAnchor: "    setBoxMigrating: async (args) => {",
    endAnchor: "    setHttpProxyName: (args) => deps.extensions.api(\"telemetry\").setHttpProxyName(args.name),",
    find: "    setBoxMigrating: async (args) => {",
    replacement: `    grokboxCurrentStateControl: async args => {
      const __grokbox_current = ${control};
      if (typeof __grokbox_current?.call !== "function") return { ok: false, error: { code: "native_unavailable" } };
      return await __grokbox_current.call(args, () => api.getHostStatus({ grokboxOwnershipAgentIds: [args.agentId] }));
    },
    setBoxMigrating: async (args) => {`,
  },
  {
    id: "continuity-native-created-owner",
    startAnchor: "var AgentLifecycle = class {",
    endAnchor: "  async kickstartAgent(agentId, isRunReady) {",
    find: "    options2.configureAgentDir?.(this.tm.sessionStore.getAgentDir(session.id));\n",
    replacement: `    options2.configureAgentDir?.(this.tm.sessionStore.getAgentDir(session.id));
    ${control}?.register(session.id, { store: session.agentStore, metadata: session.db, ctx: this.tm.ctx,
      rootId: SAND_CONVERSATION_ROOT_SLOT_ID,
      source: { hostSourceSha: "${NATIVE_CHECKPOINT_PAIR.host}", nativeSchema: "${NATIVE_CHECKPOINT_PAIR.schema}" },
      valid: () => session.db.isClosed !== true });
`,
  },
  {
    id: "continuity-native-session-owner",
    startAnchor: "var SandSessionMaterialization = class {",
    endAnchor: "// src/host/extensions/session/session-mutations.ts\nvar import_node_fs85 =",
    find: `    const maintenance = this.host.maintenanceHost();
    if (db.get("latestRootBlobId").length === 0) {
      await recoverConversationIfRootMissing(maintenance, dbPath, db, agentStore);
    }
    await repairHiddenTranscriptEntriesOnce(maintenance, dbPath, db, agentStore);
    await clearStaleCheckpointRootsOnce(maintenance, dbPath, db, agentStore);
    await retireLegacyStoreBlobsOnce(maintenance, dbPath, db, agentStore);
    scheduleConversationSizeMaintenance(maintenance, dbPath, db);
`,
    replacement: `    const maintenance = this.host.maintenanceHost();
    const __grokbox_current = ${control};
    if (__grokbox_current?.deferMaintenance(db) !== true) {
      if (db.get("latestRootBlobId").length === 0) {
        await recoverConversationIfRootMissing(maintenance, dbPath, db, agentStore);
      }
      await repairHiddenTranscriptEntriesOnce(maintenance, dbPath, db, agentStore);
      await clearStaleCheckpointRootsOnce(maintenance, dbPath, db, agentStore);
      await retireLegacyStoreBlobsOnce(maintenance, dbPath, db, agentStore);
      scheduleConversationSizeMaintenance(maintenance, dbPath, db);
    }
    __grokbox_current?.register(agentId, { store: agentStore, metadata: db, ctx: this.host.ctx,
      rootId: SAND_CONVERSATION_ROOT_SLOT_ID,
      source: { hostSourceSha: "${NATIVE_CHECKPOINT_PAIR.host}", nativeSchema: "${NATIVE_CHECKPOINT_PAIR.schema}" },
      valid: () => db.isClosed !== true });
`,
  },
  {
    id: "continuity-native-checkpoint-fence",
    startAnchor: "var AgentStore2 = class {",
    endAnchor: "// ../packages/agent-kv/dist/cached-blob-store.js",
    find: "  handleCheckpoint(ctx, checkpoint) {\n    return __awaiter43(this, void 0, void 0, function* () {\n",
    replacement: "  handleCheckpoint(ctx, checkpoint) {\n    const __grokbox_write = () => __awaiter43(this, void 0, void 0, function* () {\n",
  },
  {
    id: "continuity-native-checkpoint-revision",
    startAnchor: "var AgentStore2 = class {",
    endAnchor: "// ../packages/agent-kv/dist/cached-blob-store.js",
    find: "      this.conversationStateStructure = checkpoint;\n    });\n  }\n",
    replacement: `      this.conversationStateStructure = checkpoint;
    });
    const __grokbox_current = ${control};
    return __grokbox_current?.registered(this.getId())
      ? __grokbox_current.checkpoint(this.getId(), __grokbox_write, this)
      : __grokbox_write();
  }
`,
  },
];
