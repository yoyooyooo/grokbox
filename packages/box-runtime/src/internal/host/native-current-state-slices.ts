import type { SlicePatch } from "./profile.ts";
import { NATIVE_CURRENT_STATE_SYMBOL } from "./native-current-state-owner.ts";
import { NATIVE_CHECKPOINT_PAIR, type NativeCheckpointPair } from "./native-checkpoint-pair.ts";
import { NATIVE_BOT_LIFECYCLE_SLICES } from "./native-bot-lifecycle-slices.ts";
const control = `globalThis[Symbol.for("${NATIVE_CURRENT_STATE_SYMBOL}")]`;

/** Source metadata is emitted from the selected tuple, never inherited from a
 * former Host merely because both workers share the same binary ABI. */
export function nativeCurrentStateSlices(pair: NativeCheckpointPair): readonly SlicePatch[] {
  if (!/^[a-f0-9]{64}$/.test(pair.host) || !/^[a-z0-9-]{1,80}$/.test(pair.schema)) throw Error("native_checkpoint_pair_invalid");
  return [
  ...NATIVE_BOT_LIFECYCLE_SLICES,
  {
    id: "continuity-native-history-position",
    startAnchor: "var SandAgentDb = class {",
    endAnchor: "// src/host/extensions/session/connector-secret-store.ts",
    find: "  getTranscriptEntriesAfter(id) {\n",
    replacement: `  historyPosition(id) {
    if (this.isClosed) throw new Error("grokbox_history_closed");
    if (id === null) return this.statements.listTranscriptTail.all(null, null, 1)[0]?.seq ?? 0;
    return this.statements.getTranscriptEntrySeq.get(id)?.seq ?? null;
  }
  getTranscriptEntriesAfter(id) {
`,
  },
  {
    id: "continuity-native-instructions",
    startAnchor: "  function renderSystemPrompt(profileSnapshot,",
    endAnchor: "  function createSystemPromptGeneratorForRun({",
    find: '    push("profile", profileSnapshot?.profileSection ?? getProfileSection(profile));\n',
    replacement: `    push("profile", profileSnapshot?.profileSection ?? getProfileSection(profile));
    push("grokbox_managed_instructions", ${control}?.systemInstructions(deps.agentStore()) ?? null);
`,
  },
  {
    id: "continuity-native-history-boundary",
    startAnchor: "async function collectPrependUserMessages(host, recentUserMessages, currentMessageId) {",
    endAnchor: "// ../packages/grok-bot-harness/src/cloud-agents/cloud-agent-images.ts",
    find: "  if (recentUserMessages == null || recentUserMessages.length === 0) {\n",
    replacement: `  recentUserMessages = ${control}?.filterRecent(host, recentUserMessages) ?? recentUserMessages;
  if (recentUserMessages == null || recentUserMessages.length === 0) {
`,
  },
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
      return await __grokbox_current.call(args, () => api.getHostStatus({ grokboxOwnershipAgentIds: [args.agentId] }), {
        create: value => api.createAgent(value), load: id => manager.grokboxLoadPrepared(id),
        start: (request, authorize) => manager.grokboxStartup(request, authorize)
      });
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
      material: { memory: session.memory, history: session.db },
      rootId: SAND_CONVERSATION_ROOT_SLOT_ID,
      source: { hostSourceSha: "${pair.host}", nativeSchema: "${pair.schema}" },
      valid: () => session.db.isClosed !== true });
`,
  },
  {
    id: "continuity-native-session-owner",
    startAnchor: "var SandSessionMaterialization = class {",
    endAnchor: "// src/host/extensions/session/session-mutations.ts\nvar import_node_fs87 =",
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
      material: { memory: this.host.memory().createAgentStore((0, import_node_path138.dirname)(dbPath)), history: db },
      rootId: SAND_CONVERSATION_ROOT_SLOT_ID,
      source: { hostSourceSha: "${pair.host}", nativeSchema: "${pair.schema}" },
      valid: () => db.isClosed !== true });
`,
  },
  {
    id: "continuity-native-checkpoint-fence",
    startAnchor: "var AgentStore2 = class {",
    endAnchor: "// ../packages/agent-kv/dist/cached-blob-store.js",
    find: "  handleCheckpoint(ctx, checkpoint) {\n    return __awaiter45(this, void 0, void 0, function* () {\n",
    replacement: "  handleCheckpoint(ctx, checkpoint) {\n    const __grokbox_write = () => __awaiter45(this, void 0, void 0, function* () {\n",
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
}
export const NATIVE_CURRENT_STATE_SLICES = nativeCurrentStateSlices(NATIVE_CHECKPOINT_PAIR);
