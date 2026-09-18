import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { LIVE_HOST_BUNDLE } from "../src/internal/host/live-slices.ts";
import { nativeHostQualificationEnabled, QUALIFIED_NATIVE_HOST_SHA } from "./native-host-qualification.ts";

// Opt-in, pinned native interoperability probes, not a clone implementation.
// Only selected functions execute; filesystem, DB, identity and network are
// owned fakes. Never start the native Host or read a product Bot's content.
// CONT-00 and Spec S13 own the scope and the unproved live import boundaries.
const nativeTest = test.skipIf(!nativeHostQualificationEnabled());
let selected: Map<string, string> | undefined;
function nativeCode(name: string): string {
  if (!selected) {
    const source = readFileSync(LIVE_HOST_BUNDLE, "utf8");
    expect(createHash("sha256").update(source).digest("hex")).toBe(QUALIFIED_NATIVE_HOST_SHA);
    const parsed = ts.createSourceFile("qualified-native.cjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const functions = new Set(["cloneAgentDir", "cloneStoreDb", "writeClonedProfile", "copyIfPresent", "cloneAutomations", "rewriteClonedAgentIdentity"]);
    const methods = new Set(["clearConversation", "uploadClosure", "readWorkingStateExportSnapshot"]);
    const found = new Map<string, string>();
    function visit(node: ts.Node): void {
      const key = ts.isFunctionDeclaration(node) && node.name && functions.has(node.name.text)
        ? node.name.text
        : ts.isMethodDeclaration(node) && methods.has(node.name.getText(parsed)) ? node.name.getText(parsed) : undefined;
      if (key) {
        expect(found.has(key)).toBe(false);
        found.set(key, node.getText(parsed));
      }
      ts.forEachChild(node, visit);
    }
    visit(parsed);
    expect(found.size).toBe(functions.size + methods.size);
    selected = found;
  }
  const result = selected.get(name);
  if (!result) throw new Error(`Missing qualified native surface: ${name}`);
  return result;
}
function evaluate(code: string, globals: Record<string, unknown>): any {
  return runInNewContext(code, globals, { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } });
}
function duplicateFixture() {
  const source = "/owned/source", target = "/owned/target";
  const files = new Map<string, string>([
    [`${source}/store.db`, "synthetic-database"],
    [`${source}/settings.json`, "synthetic-settings"],
    [`${source}/conversation-blobs.db`, "synthetic-working-root-closure"],
    [`${source}/memory/profile.md`, "synthetic-memory-sentinel"],
    [`${source}/automations/daily/config`, "synthetic-enabled-routine-definition"],
  ]);
  const operations: string[] = [], profiles = new Map<string, Record<string, unknown>>();
  profiles.set(`${source}/profile.json`, { name: "Source", description: "synthetic persona", title: "source title", harness: "temporal", serverId: "source-server-id" });
  const identity: Record<string, unknown> = {};
  const globals = {
    import_node_fs78: {
      mkdirSync: (path: string) => { operations.push(`mkdir:${path}`); },
      existsSync: (path: string) => files.has(path),
      copyFileSync: (from: string, to: string) => {
        const value = files.get(from);
        if (value === undefined) throw new Error("fake source is missing");
        operations.push(`copy:${from}:${to}`); files.set(to, value);
      },
      rmSync: () => { throw new Error("Unexpected native rollback"); },
    },
    import_node_path128: posix,
    STORE_FILENAME: "store.db", CANONICAL_AVATAR_FILENAME: "avatar.png", AUTOMATION_CONFIG_FILENAME2: "config",
    checkpointSandAgentDb: (path: string) => { operations.push(`checkpoint:${path}`); },
    getSandProfilePath: (path: string) => `${path}/profile.json`,
    getSandSettingsPath: (path: string) => `${path}/settings.json`,
    getAgentAutomationsDir: (path: string) => `${path}/automations`,
    readSandProfileFile: (path: string) => profiles.get(path),
    writeSandProfileFile: (path: string, value: Record<string, unknown>) => { profiles.set(path, value); },
    writeSandSettingsFile: (_path: string, value: unknown) => { identity.settings = value; },
    listAgentAutomationConfigFiles: () => [{ folderName: "daily", configPath: `${source}/automations/daily/config` }],
    cloneAvatarFiles: () => { operations.push("avatars"); },
    SandAgentCloneError: Error,
  };
  const code = ["cloneAgentDir", "cloneStoreDb", "writeClonedProfile", "copyIfPresent", "cloneAutomations", "rewriteClonedAgentIdentity"].map(nativeCode).join("\n");
  const api = evaluate(`${code}\n({cloneAgentDir, rewriteClonedAgentIdentity})`, globals);
  const createDb = () => ({
    set: (key: string, value: unknown) => { identity[key] = value; },
    setAgentOrigin: (value: string) => { identity.origin = value; },
    clearAgentPurpose: () => { operations.push("clear-purpose"); },
    clearTransientState: () => { operations.push("clear-transient"); },
    clearConversation: () => { operations.push("clear-conversation"); },
    getSandProfile: () => ({ description: "synthetic persona" }),
    setSandProfile: () => { operations.push("set-profile"); },
    close: () => { operations.push("close"); },
  });
  return { source, target, files, profiles, operations, identity,
    duplicate: () => api.cloneAgentDir(source, target, "target-agent-id", "Target", createDb),
    rewriteWithHistory: () => api.rewriteClonedAgentIdentity(target, "target-agent-id", true, createDb),
  };
}

nativeTest("native duplicate resets identity but deliberately clears the conversation", () => {
  const f = duplicateFixture(); f.duplicate();
  expect(f.identity.agentId).toBe("target-agent-id");
  expect(f.identity.origin).toBe("user");
  expect(f.operations).toContain("clear-purpose");
  expect(f.operations).toContain("clear-transient");
  expect(f.operations).toContain("clear-conversation");
  expect(f.operations.indexOf(`checkpoint:${f.source}/store.db`)).toBeLessThan(f.operations.indexOf(`copy:${f.source}/store.db:${f.target}/store.db`));
});

nativeTest("native duplicate does not transplant server identity, working blobs or filesystem Memory", () => {
  const f = duplicateFixture(); f.duplicate();
  const profile = f.profiles.get(`${f.target}/profile.json`)!;
  expect(profile.name).toBe("Target"); expect(profile.description).toBe("synthetic persona");
  expect(profile).not.toHaveProperty("serverId"); expect(profile).not.toHaveProperty("harness");
  expect(f.files.has(`${f.target}/store.db`)).toBe(true);
  expect(f.files.has(`${f.target}/conversation-blobs.db`)).toBe(false);
  expect(f.files.has(`${f.target}/memory/profile.md`)).toBe(false);
  // Omission is not proof of Box ownership; registration still needs read-back.
});

nativeTest("native duplicate copies routine definition bytes and unhides the target; it is not a staged replacement", () => {
  const f = duplicateFixture(); f.duplicate();
  expect(f.files.get(`${f.target}/automations/daily/config`)).toBe(f.files.get(`${f.source}/automations/daily/config`));
  expect(f.identity.settings).toEqual({ hiddenFromSidebar: false });
});

nativeTest("native identity helper can preserve history, but that alone does not copy a working-state closure", () => {
  const f = duplicateFixture(); f.rewriteWithHistory();
  expect(f.operations).toContain("clear-transient");
  expect(f.operations).not.toContain("clear-conversation");
  expect(f.files.has(`${f.target}/conversation-blobs.db`)).toBe(false);
});

nativeTest("native clearConversation removes transcript and root metadata, not merely UI selection", async () => {
  const operations: string[] = []; let metadata: any;
  const constants = Object.fromEntries(["KV_AWAITING_USER_RESPONSE", "KV_LAST_TURN_SETTLEMENT", "KV_LATEST_REQUEST_ID", "KV_REQUEST_IDS", "KV_EPISODE_PENDING", "KV_MEMORY_PROMPT_SNAPSHOT", "KV_AGENT_PROFILE_PROMPT_SNAPSHOT", "KV_PROMPT_PREFIX_SNAPSHOT", "KV_PROMPT_SECTION_SNAPSHOTS", "KV_METADATA"].map(key => [key, key]));
  const Native = evaluate(`(class { ${nativeCode("clearConversation")} })`, { ...constants, Uint8Array, publishTranscriptMutation: () => undefined });
  const native = new Native();
  Object.assign(native, {
    isClosed: false, agentDirName: "synthetic-target", readMetadata: () => ({ latestRootBlobId: new Uint8Array([7]), currentPlanUri: "synthetic-plan" }),
    runWrite: (_name: string, work: () => void) => { work(); return true; },
    db: { exec: (sql: string) => { operations.push(sql); } },
    statements: {
      clearBlobs: { run: () => operations.push("clear-blobs") }, clearTranscriptEntries: { run: () => operations.push("clear-transcript") },
      clearAutomationCompletions: { run: () => operations.push("clear-completions") }, deleteKv: { run: () => undefined },
      setKv: { run: (_key: string, value: unknown) => { metadata = value; } },
    },
    serializeMetadata: (value: unknown) => value,
    notifyBoundary: { settled: () => Promise.resolve() },
    metadataVersions: { latestRootBlobId: { update: () => undefined }, currentPlanUri: { update: () => undefined } },
  });
  expect(native.clearConversation()).toBe(true);
  expect(operations).toContain("clear-transcript"); expect(operations).toContain("clear-completions");
  expect(metadata.latestRootBlobId.byteLength).toBe(0); expect(metadata.currentPlanUri).toBe("");
  expect(operations.at(-1)).toBe("COMMIT");
  await Promise.resolve();
});

nativeTest("native working-state exporter refuses Temporal before snapshot or upload", async () => {
  let reads = 0, uploads = 0;
  const Native = evaluate(`(class { ${nativeCode("uploadClosure")} })`, { skipped: (reason: string) => ({ outcome: "skipped", reason }) });
  const native = new Native();
  native.deps = { isTemporalAgent: () => true, readSnapshot: () => { reads++; throw new Error("must not read"); }, putBlob: () => { uploads++; } };
  expect(await native.uploadClosure("synthetic-source", {}, {})).toEqual({ outcome: "skipped", reason: "temporal-agent" });
  expect(reads).toBe(0); expect(uploads).toBe(0);
});

nativeTest("native working-state exporter also refuses an in-flight Box turn", async () => {
  let reads = 0;
  const Native = evaluate(`(class { ${nativeCode("uploadClosure")} })`, { skipped: (reason: string) => ({ outcome: "skipped", reason }) });
  const native = new Native();
  native.deps = { isTemporalAgent: () => false, isStoreEnabled: () => true, isTurnInFlight: () => true, readSnapshot: () => { reads++; } };
  expect(await native.uploadClosure("synthetic-source", {}, {})).toEqual({ outcome: "skipped", reason: "turn-inflight" });
  expect(reads).toBe(0);
});

nativeTest("native snapshot helper may invoke root recovery; it must not be advertised as an unconditionally read-only backup", async () => {
  let recoveries = 0;
  const Native = evaluate(`(class { ${nativeCode("readWorkingStateExportSnapshot")} })`, { getAgentDbPath: () => "/owned/synthetic/store.db" });
  const native = new Native();
  const db = { getTranscriptTail: () => ({ entries: [{}] }), get: () => new Uint8Array(), getPendingAutomationCompletions: () => [] };
  Object.assign(native, { rootDir: "/owned", agentExists: () => true, withAgentDb: (_id: string, read: (db: unknown) => unknown) => read(db),
    materialization: { recoverConversationRootIfMissing: async () => { recoveries++; return { outcome: "skipped" }; } } });
  const result = await native.readWorkingStateExportSnapshot("synthetic-source");
  expect(recoveries).toBe(1); expect(result.walk).toEqual({ outcome: "skipped", reason: "no-root" });
});
