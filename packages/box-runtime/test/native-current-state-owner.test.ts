import { expect, test } from "bun:test";
import { captureCli,startMockGateway,writeDiscovery } from "../../../test/helpers.ts";
import { writeFile } from "node:fs/promises";
import { createNativeCurrentStateRpc,type NativeLifecycleHost } from "../src/internal/host/native-current-state-rpc.ts";
import { createCurrentStateClient } from "../src/internal/io/current-state-client.node.ts";
import { ownedOwnershipSnapshot } from "./ownership-fixture.ts";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sha256Bytes } from "@grokbox/runtime-kernel/hash";
import { initializationDigest, continuityStorePolicy, type InitializeCurrentRequest, CONTEXT_INSTRUCTIONS_KEY } from "@grokbox/runtime-kernel/continuity";
import { openContinuityCurrentState, openContinuityRecoveryStore } from "../src/runtime.ts";
import { createNativeCurrentStateOwner, NATIVE_CURRENT_STATE_KEY } from "../src/internal/host/native-current-state-owner.ts";
import { createNativeCheckpointWorker, type NativeCheckpointWorkerStore } from "../src/internal/host/native-checkpoint-worker.ts";
import type { NativeCheckpointSchema } from "../src/internal/host/native-checkpoint.ts";

const sourceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", targetId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const scopeId = "e".repeat(64), policyRevision = "b".repeat(64), qualification = { hostSourceSha: "d".repeat(64), nativeSchema: "owned-worker-v1" };
const bytes = (s: string) => new TextEncoder().encode(s), rootId = bytes("slot"), childId = bytes("leaf"), hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
function fixture(agentId: string, populated: boolean, material = false) {
  const db = new Database(":memory:"); db.exec("CREATE TABLE blobs(id TEXT PRIMARY KEY,data BLOB); CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT)");
  let writes = 0, casFailure = false, opened = true;
  const workerStore: NativeCheckpointWorkerStore = { db: { exec: sql => db.exec(sql), prepare: sql => db.query(sql) as never }, isClosed: false,
    blobLengthStmt: db.query("SELECT length(data) len FROM blobs WHERE id=?") as never,
    getBlob: id => (db.query("SELECT data FROM blobs WHERE id=?").get(hex(id)) as any)?.data,
    setBlob: (id, data) => { writes++; db.query("INSERT INTO blobs VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(hex(id), data); } };
  const message = (raw: Uint8Array) => {
    const fixtureSeed = raw.byteLength === 0 || new TextDecoder().decode(raw).startsWith('{"ownedSeed":');
    const parsed = raw.byteLength && fixtureSeed ? JSON.parse(new TextDecoder().decode(raw)) : null;
    let refs: Uint8Array[] = fixtureSeed ? (parsed?.refs ?? []).map((h: string) => Uint8Array.from(Buffer.from(h, "hex"))) : [childId];
    return { get messages() { return refs; }, get rootPromptMessagesJson() { return refs; }, set rootPromptMessagesJson(v: Uint8Array[]) { refs = v; }, pendingToolCalls: [],
      toBinary: () => fixtureSeed ? bytes(JSON.stringify({ ownedSeed: true, refs: refs.map(hex) })) : Uint8Array.from(raw),
      getType: () => ({ typeName: "agent.v1.ConversationStateStructure", fields: { list: () => [{ localName: "messages", kind: "scalar", repeated: true }] },
        runtime: { bin: { listUnknownFields: () => [] } } }) };
  };
  const schema: NativeCheckpointSchema = { root: { fromBinary: message }, isMessage: () => true, referenceTypes: {},
    referenceMetadata: () => ({ fields: [{ localFieldName: "messages", protoFieldName: "messages", blobReferenceType: "json" }] }) };
  const worker = createNativeCheckpointWorker({ store: workerStore, schema, qualification, agentId });
  const readKv = (key: string): string | null => (db.query("SELECT value FROM kv WHERE key=?").get(key) as any)?.value ?? null;
  const writeKv = (key: string, value: string) => { db.query("INSERT INTO kv VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value); return true; };
  const metadata = { readKv, writeKv,
    deleteKv: (key: string) => db.query("DELETE FROM kv WHERE key=?").run(key),
    historyPosition: (id: string | null) => id === null ? entries.length : entries.findIndex(e => e.id === id) < 0 ? null : entries.findIndex(e => e.id === id) + 1,
    getTranscriptTail: (_query: { limit: number }) => ({ entries: readKv("owned-history") ? [{}] : [] }),
    getPendingAutomationCompletions: () => readKv("owned-completion") ? [{}] : [],
    compareAndSetLatestRootBlobId: (v: { expectedRoot: Uint8Array; nextRoot: Uint8Array }) => {
    if (casFailure || (readKv("root") ?? "") !== hex(v.expectedRoot)) return false;
    writeKv("root", hex(v.nextRoot)); return true;
  } };
  let loaded = message(new Uint8Array());
  if (populated) {
    workerStore.setBlob(rootId, bytes("ROOT")); workerStore.setBlob(childId, bytes('{"role":"user","content":"CURRENT_SENTINEL"}'));
    writeKv("root", hex(rootId)); loaded = message(bytes("ROOT"));
  }
  writeKv("memory", "TARGET_MEMORY_UNCHANGED");
  const store = { getMetadata: () => Uint8Array.from(Buffer.from(readKv("root") ?? "", "hex")), getConversationStateStructure: () => loaded,
    resetFromDb: async (_ctx?: unknown) => { const pointer = Uint8Array.from(Buffer.from(readKv("root") ?? "", "hex")); loaded = message(pointer.length ? workerStore.getBlob(pointer) ?? new Uint8Array() : new Uint8Array()); },
    getBlobStore: () => ({ grokboxCurrentState: async (action: "capture" | "compose" | "prepare" | "apply" | "observe" | "release", value: unknown) => worker[action](value) }) };
  const owner = createNativeCurrentStateOwner({ qualification, generation: "owned-generation" });
  const memories: any[] = populated ? [{ content: "LONG_TERM_FACT", createdAt: 1, kind: "profile" }] : [];
  const entries: any[] = populated ? [{ id: "history-1", kind: "message", role: "user", content: "HISTORICAL_FACT", timestampMs: 1 }] : [];
  const nativeMaterial = { memory: { listMemories: (n: number) => memories.slice(0, n), countMemories: () => memories.length,
      addMemory: (content: string, createdAt: number, kind: string) => { if (!memories.some(m => m.content === content)) memories.push({ content, createdAt, kind }); } },
    history: { getTranscriptTail: (q: { limit: number }) => ({ entries: entries.slice(-q.limit) }),
      getEntryById: (id: string) => entries.find(e => e.id === id),
      appendTranscriptEntries: (values: unknown[]) => { for (const e of values as any[]) if (!entries.some(p => p.id === e.id)) entries.push(JSON.parse(JSON.stringify(e))); return true; } } };
  const registration = { store, metadata, ctx: {}, rootId, source: qualification, valid: () => opened, ...(material ? { material: nativeMaterial } : {}) };
  owner.register(agentId, registration);
  return { owner, store, worker, workerStore, metadata, registration, memories, entries, reads: () => writes, failCas: () => { casFailure = true; },
    head: () => owner.readHead(agentId, scopeId), close: () => { opened = false; db.close(); } };
}
async function setup(material = false) {
  const base = await mkdtemp(join(tmpdir(), "native-owner-test-")), durableRoot = join(base, "durable");
  await mkdir(durableRoot, { mode: 0o700 });
  const source = fixture(sourceId, true, material), target = fixture(targetId, false, material);
  const store = openContinuityRecoveryStore({ durableRoot, scopeId }); await store.initialize();
  const sourceProgram = openContinuityCurrentState({ durableRoot, scopeId, native: source.owner.port });
  const requestId = randomUUID(); await sourceProgram.capture({ requestId, expected: source.head() });
  const snapshot = (await store.readSnapshot(requestId)).reference;
  const request = { operationId: randomUUID(), effectId: randomUUID(), snapshot, expected: target.head(), policyRevision };
  const program = openContinuityCurrentState({ durableRoot, scopeId, native: target.owner.port,
    authorizeInitialization: async () => ({ allowed: true, operationId: request.operationId, agentId: targetId, scopeId, policyRevision,
      ownership: "confirmed_box", observedAtMs: Date.now(), hostGeneration: "owned-generation" }) });
  return { source, target, store, program, request, durableRoot,
    close: async () => { source.close(); target.close(); await rm(base, { recursive: true, force: true }); } };
}

test("reset replaces only current context, preserves Memory and instructions, and establishes an exact historical input floor", async () => {
  const f = await setup(true);
  try {
    await f.program.initialize(f.request);
    await f.target.owner.activate(f.target.head(), { ...f.request, inputDigest: initializationDigest(f.request) });
    const expected = f.target.head(), backupId = randomUUID();
    const capture = openContinuityCurrentState({ durableRoot: f.durableRoot, scopeId, native: f.target.owner.port });
    await capture.capture({ requestId: backupId, expected });
    const backup = await f.store.readSnapshot(backupId);
    const candidate = await f.target.owner.compose(expected, { version: 1, purpose: "reset", sourceId: targetId,
      sourceRevision: expected.contextRevision, instructions: "", summary: "" });
    const materialId = randomUUID(); await f.store.publish({ requestId: materialId, ...candidate });
    const snapshot = (await f.store.readSnapshot(materialId)).reference;
    const request: InitializeCurrentRequest = { operationId: randomUUID(), effectId: randomUUID(), expected, snapshot, policyRevision,
      mode: "reset", backupSnapshot: backup.reference };
    const reset = openContinuityCurrentState({ durableRoot: f.durableRoot, scopeId, native: f.target.owner.port,
      authorizeInitialization: async () => ({ allowed: true, operationId: request.operationId, agentId: targetId, scopeId, policyRevision,
        ownership: "confirmed_box", observedAtMs: Date.now(), hostGeneration: "owned-generation" }) });
    const originalMemory = structuredClone(f.target.memories);
    expect(await reset.initialize(request)).toMatchObject({ state: "prepared" });
    expect(f.target.memories).toEqual(originalMemory);
    expect(f.target.store.getConversationStateStructure().messages).toHaveLength(0);
    f.target.entries.push({ id: "new-user", kind: "message", role: "user", content: "new", timestampMs: 2 });
    expect(f.target.owner.filterRecent({ getConversationId: () => targetId }, [{ id: "history-1" }, { id: "new-user" }])).toEqual([{ id: "new-user" }]);
    expect(await reset.initialize(request)).toMatchObject({ state: "already_applied", effectDispatched: false });
    expect(await f.program.reconcile(f.request)).toMatchObject({ state: "already_applied" });
  } finally { await f.close(); }
});

test("native initialization restores Memory and historical display without re-injecting those historical user messages", async () => {
  const f = await setup(true);
  try {
    const snapshot = await f.store.readSnapshot(f.request.snapshot.ref);
    expect(snapshot.manifest.parts.some(p => p.id === "bot:supplement")).toBe(true);
    expect(snapshot.manifest.gaps).not.toContain("memory_partial");
    expect(await f.program.initialize(f.request)).toMatchObject({ state: "prepared", activated: false });
    expect(f.target.memories).toEqual(f.source.memories);
    expect(f.target.entries[0]).toMatchObject({ content: "HISTORICAL_FACT", continuitySource: { agentId: sourceId, entryId: "history-1", historical: true } });
    expect(f.target.owner.filterRecent({ getConversationId: () => targetId }, [{ id: f.target.entries[0].id, text: "HISTORICAL_FACT" }, { id: "new", text: "NEW_INPUT" }])).toEqual([{ id: "new", text: "NEW_INPUT" }]);
    await f.target.owner.activate(f.target.head(), { ...f.request, inputDigest: initializationDigest(f.request) });
    expect(f.target.worker.permitsOrdinary("collect-garbage")).toBe(true);
  } finally { await f.close(); }
});

test("supplemental readback failure blocks activation even when the native working root is intact", async () => {
  const f = await setup(true);
  try {
    await f.program.initialize(f.request); f.target.memories.length = 0;
    await expect(f.target.owner.activate(f.target.head(), { ...f.request, inputDigest: initializationDigest(f.request) })).rejects.toThrow("commit_unknown");
    expect(f.target.worker.permitsOrdinary("collect-garbage")).toBe(false);
    expect(() => f.target.owner.enter(targetId)).toThrow("not_prepared");
  } finally { await f.close(); }
});

test("concrete native metadata/blob owner completes the production coordinator and keeps both native fences prepared", async () => {
  const f = await setup();
  try {
    expect(await f.program.initialize(f.request)).toMatchObject({ state: "prepared", current: "verified_prepared", activated: false, humanMessageSent: false });
    expect(f.target.store.getConversationStateStructure().toBinary()).toEqual(bytes("ROOT"));
    expect(f.target.metadata.readKv("memory")).toBe("TARGET_MEMORY_UNCHANGED");
    expect(f.target.worker.permitsOrdinary("collect-garbage")).toBe(false);
    expect(() => f.target.owner.enter(targetId)).toThrow("not_prepared");
    const applied = await f.target.owner.port.observeApplication({ ...f.request, inputDigest: initializationDigest(f.request) });
    expect(applied.state).toBe("applied");
  } finally { await f.close(); }
});

test("explicit release opens only subsequent work, B2 is never overwritten by initialization re-entry", async () => {
  const f = await setup();
  try {
    await f.program.initialize(f.request);
    expect(await f.target.owner.activate(f.target.head(), { ...f.request, inputDigest: initializationDigest(f.request) })).toMatchObject({ state: "released", started: false });
    expect(f.target.worker.permitsOrdinary("collect-garbage")).toBe(true);
    const end = f.target.owner.enter(targetId);
    await f.target.owner.checkpoint(targetId, async () => { f.target.workerStore.setBlob(rootId, bytes("B2")); await f.target.store.resetFromDb({}); });
    end();
    expect(await f.program.initialize(f.request)).toMatchObject({ state: "already_applied", effectDispatched: false });
    expect(f.target.store.getConversationStateStructure().toBinary()).toEqual(bytes("B2"));
  } finally { await f.close(); }
});

test("worker commit followed by metadata failure leaves durable blocked state and cannot be replayed", async () => {
  const f = await setup();
  try {
    f.target.failCas(); await expect(f.program.initialize(f.request)).rejects.toThrow("commit_unknown");
    expect(JSON.parse(f.target.metadata.readKv(NATIVE_CURRENT_STATE_KEY)!)).toMatchObject({ hold: "blocked" });
    expect(f.target.workerStore.getBlob(rootId)).toEqual(bytes("ROOT"));
    expect(f.target.head().rootHash).toBeNull();
    expect(await f.program.reconcile(f.request)).toMatchObject({ state: "unknown", activated: false });
    const fresh = createNativeCurrentStateOwner({ qualification, generation: "new-process" }); fresh.register(targetId, f.target.registration);
    expect(() => fresh.enter(targetId)).toThrow("not_prepared");
    expect(fresh.deferMaintenance(f.target.metadata)).toBe(true);
  } finally { await f.close(); }
});

test("current running or already populated target cannot be used as a virgin initializer", async () => {
  const f = await setup();
  try {
    const done = f.target.owner.enter(targetId);
    await expect(f.program.initialize(f.request)).rejects.toThrow(); done();
    expect(f.target.workerStore.getBlob(rootId)).toBeUndefined();
    const material = await f.store.readSnapshot(f.request.snapshot.ref);
    const populated = fixture(targetId, true);
    try {
      const bad = { ...f.request, expected: populated.head(), inputDigest: initializationDigest({ ...f.request, expected: populated.head() }) };
      await expect(populated.owner.port.initialize(bad)).rejects.toThrow("not_prepared");
    } finally { populated.close(); }
    expect(material.manifest.parts).toHaveLength(2);
  } finally { await f.close(); }
});

for (const key of ["owned-history", "owned-completion", "latestRequestId", "requestIds", "lastTurnSettlement", "awaitingUserResponse"]) {
  test(`rootless target with ${key} is not a virgin Bot`, async () => {
    const f = await setup();
    try {
      f.target.metadata.writeKv(key, "existing-record");
      await expect(f.program.initialize(f.request)).rejects.toThrow("not_prepared");
      expect(f.target.workerStore.getBlob(rootId)).toBeUndefined();
      expect(f.target.metadata.readKv(key)).toBe("existing-record");
      expect(f.target.metadata.readKv(NATIVE_CURRENT_STATE_KEY)).toBeNull();
    } finally { await f.close(); }
  });
}

test("a completion arriving after preview prevents initialization dispatch", async () => {
  const f = await setup();
  try {
    const attempt = { ...f.request, inputDigest: initializationDigest(f.request) };
    const lease = await f.target.owner.port.initialize(attempt);
    try {
      const candidate = await lease.prepare(await f.store.readSnapshot(f.request.snapshot.ref), attempt);
      f.target.metadata.writeKv("owned-completion", "late-result");
      await expect(lease.commit(attempt, candidate)).rejects.toThrow("not_prepared");
      expect(f.target.workerStore.getBlob(rootId)).toBeUndefined();
    } finally { await lease.release("blocked"); }
  } finally { await f.close(); }
});

test("a native result arriving while the worker commits prevents main-root publication", async () => {
  const f = await setup();
  try {
    const apply = f.target.worker.apply;
    f.target.worker.apply = async payload => {
      const result = await apply(payload);
      f.target.metadata.writeKv("owned-completion", "arrived-during-worker-commit");
      return result;
    };
    await expect(f.program.initialize(f.request)).rejects.toThrow("commit_unknown");
    expect(f.target.workerStore.getBlob(rootId)).toEqual(bytes("ROOT"));
    expect(f.target.store.getMetadata()).toHaveLength(0);
    expect(f.target.metadata.readKv("owned-completion")).toBe("arrived-during-worker-commit");
    expect(JSON.parse(f.target.metadata.readKv(NATIVE_CURRENT_STATE_KEY)!)).toMatchObject({ hold: "blocked" });
    expect(f.target.worker.permitsOrdinary("collect-garbage")).toBe(false);
    expect(await f.program.reconcile(f.request)).toMatchObject({ state: "unknown", activated: false });
  } finally { await f.close(); }
});

test("stale native store and malformed persistent fence fail closed without mutating live content", async () => {
  const f = fixture(sourceId, true);
  try {
    expect(() => f.owner.assertCheckpoint(sourceId, { ...f.store })).toThrow("not_prepared");
    f.metadata.writeKv(NATIVE_CURRENT_STATE_KEY, "not-json");
    expect(f.owner.deferMaintenance(f.metadata)).toBe(true);
    expect(() => f.head()).toThrow("commit_unknown");
    expect(() => f.owner.enter(sourceId)).toThrow("commit_unknown");
    expect(f.workerStore.getBlob(rootId)).toEqual(bytes("ROOT"));
  } finally { f.close(); }
});

test("an unfinished native checkpoint holds its boundary until the entire write settles", async () => {
  const f = await setup(); let release!: () => void;
  try {
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const writing = f.target.owner.checkpoint(targetId, () => barrier, f.target.store);
    await expect(f.target.owner.port.initialize({ ...f.request, inputDigest: initializationDigest(f.request) })).rejects.toThrow("not_prepared");
    expect(() => f.target.owner.register(targetId, f.target.registration)).toThrow("not_prepared");
    release(); await writing;
    // A checkpoint with no root is still evidence this is not an untouched Bot.
    const later = { ...f.request, expected: f.target.head() };
    await expect(f.target.owner.port.initialize({ ...later, inputDigest: initializationDigest(later) })).rejects.toThrow("not_prepared");
  } finally { release?.(); await f.close(); }
});

test("a started Bot with no checkpoint is not a virgin target after a controller restart", async () => {
  const f = await setup();
  try {
    f.target.owner.enter(targetId)();
    const fresh = createNativeCurrentStateOwner({ qualification, generation: "next-generation" });
    fresh.register(targetId, f.target.registration);
    const request = { ...f.request, expected: fresh.readHead(targetId, scopeId) };
    await expect(fresh.port.initialize({ ...request, inputDigest: initializationDigest(request) })).rejects.toThrow("not_prepared");
    expect(f.target.workerStore.getBlob(rootId)).toBeUndefined();
  } finally { await f.close(); }
});

test("program startup consumes one private ticket and persists an exact non-user operation",async()=>{
  const f=fixture(sourceId,true);try{
    const request={operationId:randomUUID(),expected:f.head(),maxRunMs:1000};let turns=0;
    const result=await f.owner.startup(request,async ticket=>{
      const end=f.owner.enter(sourceId,ticket);try{expect(f.owner.consumeStartup(sourceId,ticket)).toBe(true);expect(f.owner.consumeStartup(sourceId,ticket)).toBe(false);expect(f.owner.isStartupUserMessage(sourceId,{text:"",isSimulatedMsg:true,messageId:f.owner.startupMessageId(sourceId)})).toBe(true);turns++;return {}; }finally{end();}
    },()=>{throw Error("unexpected interruption");});
    expect(result).toMatchObject({state:"settled",started:true,source:"program_startup",businessComplete:false});
    expect(await f.owner.startup(request,async()=>{turns++;return {};},()=>{})).toMatchObject({duplicate:true});expect(turns).toBe(1);
    await expect(f.owner.startup({...request,maxRunMs:2000},async()=>({}),()=>{})).rejects.toThrow("operation_conflict");
    expect(f.metadata.getTranscriptTail({limit:10}).entries).toHaveLength(0);
  }finally{f.close();}
});

test("consuming a startup ticket without creating its original turn cannot report settled startup", async () => {
  const f=fixture(sourceId,true);
  try {
    const request={operationId:randomUUID(),expected:f.head(),maxRunMs:1000};
    await expect(f.owner.startup(request,async ticket=>{
      const end=f.owner.enter(sourceId,ticket);
      try { expect(f.owner.consumeStartup(sourceId,ticket)).toBe(true); return {}; } finally { end(); }
    },()=>{})).rejects.toThrow("native_unavailable");
    expect(f.owner.startupStatus(sourceId,request.operationId)).toMatchObject({state:"failed",resultUnknown:true});
    expect(f.owner.isStartupUserMessage(sourceId,{text:"",isSimulatedMsg:true,messageId:`grokbox-startup:${request.operationId}`})).toBe(false);
  } finally { f.close(); }
});

test("startup reservation excludes ordinary input and a lost result never becomes another start",async()=>{
  const f=fixture(sourceId,true);try{
    const request={operationId:randomUUID(),expected:f.head(),maxRunMs:1000};let starts=0;
    await expect(f.owner.startup(request,async ticket=>{
      expect(()=>f.owner.enter(sourceId)).toThrow("not_prepared");
      const end=f.owner.enter(sourceId,ticket);try{f.owner.consumeStartup(sourceId,ticket);starts++;throw Error("owned-lost-result");}finally{end();}
    },()=>{})).rejects.toThrow("owned-lost-result");
    const again=await f.owner.startup(request,async()=>{starts++;return {};},()=>{});
    expect(again).toMatchObject({state:"failed",resultUnknown:true,duplicate:true});expect(starts).toBe(1);
  }finally{f.close();}
});

for(const kind of ["clone","spawn"] as const){
  test(`full ${kind} CLI traverses Gateway, lifecycle ledger, native owner, worker transaction and material readback`,async()=>{
    const base=await mkdtemp(join(tmpdir(),"lifecycle-native-cli-")),root=join(base,"durable");await mkdir(root,{mode:0o700});
    const source=fixture(sourceId,true,true),owner=createNativeCurrentStateOwner({qualification,generation:"owned-generation"});owner.register(sourceId,source.registration);
    let target:ReturnType<typeof fixture>|undefined,births=0,turns=0,firstInstructions:string|null=null;
    const readOwnership=async()=>({grokboxOwnership:ownedOwnershipSnapshot([sourceId,targetId],{scopeId,nowMs:Date.now(),serverHarness:"box",localHarness:"box"})});
    const native=createNativeCurrentStateRpc(owner,"c".repeat(64));
    const lifecycle:NativeLifecycleHost={
      create:async args=>{births++;target=fixture(targetId,false,true);owner.register(targetId,target.registration);owner.stageBirth(targetId,args.clientNonce);return {agent:{id:targetId}};},
      load:async()=>{},
      start:async(request,authorize)=>{await authorize();return owner.startup(request,async ticket=>{const end=owner.enter(targetId,ticket);try{expect(owner.consumeStartup(targetId,ticket)).toBe(true);expect(owner.isStartupUserMessage(targetId,{text:"",isSimulatedMsg:true,messageId:owner.startupMessageId(targetId)})).toBe(true);turns++;firstInstructions=owner.systemInstructions(target!.store);return {};}finally{end();}},()=>{});},
    };
    const gateway=await startMockGateway({agents:[{id:sourceId,name:"Source",description:"source profile",title:"",isGroup:false}],
      hostStatus:{grokboxOwnership:ownedOwnershipSnapshot([sourceId,targetId],{scopeId,nowMs:Date.now(),serverHarness:"box",localHarness:"box"})},
      currentStateControl:body=>native(body,readOwnership,lifecycle)});
    try{
      const discoveryPath=await writeDiscovery({port:gateway.port,pid:gateway.pid,startedAt:gateway.startedAt,token:gateway.token});
      const instructionFile=join(base,"instructions.md");await writeFile(instructionFile,"EXPLICIT_INITIAL_SYSTEM_DUTY");
      const op=randomUUID(),args=["agents",kind,...(kind==="clone"?[sourceId]:[]),"--operation-id",op,"--system-prompt-file",instructionFile,"--json"];
      const deps={configDir:join(base,"config"),boxRuntimeRoot:root,env:{},discoveryPath,transport:"local" as const,skillsDir:join(import.meta.dir,"../../../skills")};
      const preview=await captureCli(args,deps);expect(preview.code,preview.stderr).toBe(0);expect(births).toBe(0);
      const plan=JSON.parse(preview.stdout).data;
      const result=await captureCli([...args,"--scope-id",plan.scopeId,"--expect-plan",plan.planRevision,"--confirm"],deps);
      expect(result.code,result.stderr).toBe(0);expect(JSON.parse(result.stdout).data).toMatchObject({blocked:false,targetId,phase:kind==="clone"?"ready":"active"});
      expect(births).toBe(1);expect(turns).toBe(kind==="spawn"?1:0);
      if(kind==="clone"){expect(target!.memories.some(m=>m.content==="LONG_TERM_FACT")).toBe(true);expect(target!.entries[0]?.continuitySource).toMatchObject({agentId:sourceId,historical:true});}
      else expect(String(firstInstructions)).toContain("EXPLICIT_INITIAL_SYSTEM_DUTY");
      expect(gateway.requests.some(r=>/sendPrompt|kickstartAgent/.test(r.pathname))).toBe(false);
      const again=await captureCli([...args,"--scope-id",plan.scopeId,"--expect-plan",plan.planRevision,"--confirm"],deps);expect(again.code,again.stderr).toBe(0);expect(births).toBe(1);expect(turns).toBe(kind==="spawn"?1:0);
    }finally{gateway.stop();source.close();target?.close();await rm(base,{recursive:true,force:true});}
  },30000);
}

test("typed RPC and client run the real coordinator through prepare, initialize, reconcile and release", async () => {
  const f = await setup();
  try {
    let harness: "box" | "temporal" = "box"; let reads = 0;
    const rpc = createNativeCurrentStateRpc(f.target.owner, "c".repeat(64));
    const client = createCurrentStateClient({ qualification, call: request => rpc(request, async () => {
      reads++; return { grokboxOwnership: ownedOwnershipSnapshot([targetId], { scopeId, nowMs: Date.now(), serverHarness: harness, localHarness: harness }) };
    }) });
    const first = await client.head(targetId);
    const request = { ...f.request, expected: first.head, policyRevision: first.policyRevision };
    const program = openContinuityCurrentState({ durableRoot: f.durableRoot, scopeId, native: client.port,
      authorizeInitialization: async () => ({ allowed: true, operationId: request.operationId, agentId: targetId, scopeId,
        policyRevision: request.policyRevision, ownership: "confirmed_box", observedAtMs: Date.now(), hostGeneration: "owned-generation" }) });
    expect(await program.initialize(request)).toMatchObject({ state: "prepared", activated: false });
    const saved = await f.store.initializationRequest(request.operationId); expect(saved).toEqual(request);
    const attempt = { ...request, inputDigest: initializationDigest(request) };
    harness = "temporal";
    await expect(client.activate(attempt, (await client.head(targetId)).head)).rejects.toThrow("ownership_unconfirmed");
    expect(() => f.target.owner.enter(targetId)).toThrow("not_prepared");
    harness = "box";
    expect(await client.activate(attempt, (await client.head(targetId)).head)).toMatchObject({ state: "released", started: false });
    expect(await client.activate(attempt, (await client.head(targetId)).head)).toMatchObject({ alreadyReleased: true, started: false });
    expect(await program.reconcile(request)).toMatchObject({ state: "already_applied", effectDispatched: false });
    expect(reads).toBeGreaterThan(5);
  } finally { await f.close(); }
});
