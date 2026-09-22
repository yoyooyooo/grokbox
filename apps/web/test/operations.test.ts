import { expect, test } from "bun:test";
import { retainHandoverContinuation, handoverLocalState } from "../src/lib/operations.ts";
import { randomUUID } from "node:crypto";
import { fileReference, type FileOperation, materialReference, type ModelChangeRequest } from "@grokbox/client";
import { fileLocalState, retainFileOperation, retainCompactionContinuation, compactionLocalState, retainContextContinuation, contextLocalState, forgetSettledOperation, localOperations, markOperation, rememberOperation, operationSearch } from "../src/lib/operations.ts";

const scope = { installationId: "11111111-1111-4111-8111-111111111111", principalId: "owner" };
const request = (): ModelChangeRequest => ({ requestId: randomUUID(), expectedRevision: "a".repeat(64),
  change: { kind: "model-patch", modelId: "channel/first", patch: { apiKeyRef: "env:SYNTHETIC_PRIVATE_REFERENCE" } } });
function memoryStorage() {
  const values = new Map<string, string>();
  return { values, get length() { return values.size; }, key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); } };
}

test("file locators retain only original source/request and cannot discard unknown staging or store reusable approval",()=>{
  const storage=memoryStorage(),requestId=randomUUID(),ref=fileReference(scope.installationId,"b".repeat(64),"files","nested/文件.txt");
  const row=rememberOperation(storage,scope,{requestId,ref,action:"upload",confirmed:true,expectedRevision:null,size:1,sha256:"d".repeat(64)});
  expect(operationSearch(row)).toMatchObject({domain:"file",requestId});expect(row.target).toBe(ref);
  expect([...storage.values.values()].join()).not.toMatch(/sha256|expectedRevision|confirmed|size|generation|content/);
  expect(()=>forgetSettledOperation(storage,row)).toThrow();
  const receipt:FileOperation={version:1,requestId,ref,action:"upload",operationRef:`file-operation:${scope.installationId}:${"a".repeat(64)}`,expectedRevision:null,state:"unknown",acceptedAtMs:1,settledAtMs:null,result:null,serviceGeneration:randomUUID(),externalCompareAndSwap:false,indexAdoption:"not-observed"};
  const retained=retainFileOperation(storage,scope,receipt);expect(retained.createdAt).toBe(row.createdAt);expect(localOperations(storage,scope)).toEqual([retained]);
  expect(()=>retainFileOperation(storage,scope,{...receipt,ref:fileReference(scope.installationId,"b".repeat(64),"files","other")})).toThrow();
  expect([...storage.values.values()].join()).not.toContain(receipt.serviceGeneration);
  markOperation(storage,retained,fileLocalState("cancelled"));forgetSettledOperation(storage,retained);expect(localOperations(storage,scope)).toEqual([]);
});

test("desktop locators retain original scope but neither candidate approval nor a reusable protection policy",()=>{
  const storage=memoryStorage(),requestId=randomUUID();
  const prune=rememberOperation(storage,scope,{requestId,expectedRevision:"a".repeat(64),confirmed:true});
  expect(operationSearch(prune)).toMatchObject({domain:"desktop",requestId});
  const policy=rememberOperation(storage,scope,{requestId:randomUUID(),expectedRevision:"b".repeat(64),confirmed:true,action:"keep",agentIds:["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]});
  expect(operationSearch(policy)).toMatchObject({domain:"desktop-policy"});
  expect([...storage.values.values()].join()).not.toMatch(/agentIds|expectedRevision|confirmed|aaaaaaaa|enabled|minIdleMs/);
  markOperation(storage,prune,"unknown");expect(()=>forgetSettledOperation(storage,prune)).toThrow();expect(localOperations(storage,scope)).toHaveLength(2);
  markOperation(storage,policy,"succeeded");forgetSettledOperation(storage,policy);expect(localOperations(storage,scope)).toHaveLength(1);
});

test("Job locators separate known admission, unknown execution and cancellation without persisting argv or authority",()=>{
  const storage=memoryStorage(),requestId=randomUUID(),ref=`job:${scope.installationId}:${randomUUID()}`;
  const start=rememberOperation(storage,scope,{requestId,expectedRevision:"f".repeat(64),confirmed:true,argv:["node","-e","PRIVATE_JOB_SCRIPT"],environment:{VISIBLE:"PRIVATE_ENV"},runTimeoutMs:1000,output:"capture",shell:false});
  expect(operationSearch(start)).toMatchObject({domain:"job",requestId});
  const serialized=[...storage.values.values()].join();expect(serialized).not.toMatch(/PRIVATE_JOB_SCRIPT|PRIVATE_ENV|expectedRevision|argv|environment|confirmed/);
  expect(()=>forgetSettledOperation(storage,start)).toThrow();markOperation(storage,start,"recorded");forgetSettledOperation(storage,start);
  const cancel=rememberOperation(storage,scope,{jobRef:ref,requestId:randomUUID(),confirmed:true});expect(operationSearch(cancel)).toMatchObject({domain:"job-cancel",target:ref});
  markOperation(storage,cancel,"unknown");expect(()=>forgetSettledOperation(storage,cancel)).toThrow();expect(localOperations(storage,scope)).toHaveLength(1);
  expect(()=>rememberOperation(storage,scope,{jobRef:ref.replace(scope.installationId,randomUUID()),requestId:randomUUID(),confirmed:true})).toThrow();
});

test("operation locators are persisted before send and contain no model input or authentication", () => {
  const storage = memoryStorage(), input = request();
  const row = rememberOperation(storage, scope, input);
  expect(row.requestId).toBe(input.requestId);
  expect(row.state).toBe("awaiting-response");
  expect(localOperations(storage, scope)).toEqual([row]);
  const serialized = [...storage.values.values()].join("");
  expect(serialized).not.toContain("SYNTHETIC_PRIVATE_REFERENCE");
  expect(serialized).not.toContain("expectedRevision");
  expect(serialized).not.toMatch(/csrf|cookie|apiKeyRef|"patch"/);
});

test("incident send stores only original work/request scope, never reusable approval or receiver input", () => {
  const storage = memoryStorage(), databaseId = randomUUID(), requestId = randomUUID();
  const ref = `notification:${scope.installationId}:${databaseId}:${randomUUID()}`;
  const row = rememberOperation(storage, scope, { notificationRef: ref, receiverRef: `receiver:${scope.installationId}:${databaseId}:${randomUUID()}`,
    requestId, expectedRevision: 7, expectedModelRevision: "b".repeat(64), confirmed: true });
  expect(row.target).toBe(ref); expect(row.command).toBe("notification-send");
  expect(operationSearch(row)).toEqual({ requestId, domain: "notification", databaseId });
  const text = [...storage.values.values()].join();
  expect(text).not.toMatch(/expectedRevision|expectedModelRevision|receiverRef|confirmed/); expect(text).not.toContain("b".repeat(64));
  markOperation(storage, row, "unknown"); expect(() => forgetSettledOperation(storage, row)).toThrow();
  expect(localOperations(storage, scope)[0]?.state).toBe("unknown");
  const only = [...storage.values.keys()][0]!;
  storage.setItem(only, JSON.stringify({ ...row, target: row.target.replace("notification:", "receiver:") }));
  expect(() => localOperations(storage, scope)).toThrow();
});

test("different requests and principals cannot overwrite each other's recovery locators", () => {
  const storage = memoryStorage();
  const first = rememberOperation(storage, scope, request());
  const second = rememberOperation(storage, scope, request());
  const other = rememberOperation(storage, { ...scope, principalId: "reader" }, request());
  markOperation(storage, first, "succeeded");
  expect(localOperations(storage, scope).map(row => row.requestId).sort()).toEqual([first.requestId, second.requestId].sort());
  expect(localOperations(storage, { ...scope, principalId: "reader" })).toEqual([other]);
  expect(localOperations(storage, { ...scope, installationId: "99999999-9999-4999-8999-999999999999" })).toEqual([]);
});

test("context recovery stores only original scope and target, and explicit continuation cannot erase an unresolved locator", () => {
  const storage = memoryStorage(), id = randomUUID(), bot = `bot:${scope.installationId}:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`, account = "b".repeat(64);
  const row = rememberOperation(storage, scope, { requestId: id, botRef: bot, scopeId: account, expectedRevision: "d".repeat(64), action: "restore", confirmed: true,
    snapshotRef: `snapshot:${scope.installationId}:${account}:${randomUUID()}` });
  expect(operationSearch(row)).toMatchObject({ domain: "context", requestId: id, scopeId: account });
  expect([...storage.values.values()].join()).not.toMatch(/snapshotRef|expectedRevision|restore|csrf/);
  markOperation(storage, row, contextLocalState("prepared"));
  const continuation = { requestId: id, scopeId: account, botRef: bot, action: "activate" as const, confirmed: true as const, expectedRevision: "f".repeat(64) };
  const next = retainContextContinuation(storage, scope, continuation); expect(next.createdAt).toBe(row.createdAt); expect(localOperations(storage, scope)[0]?.state).toBe("awaiting-response");
  expect(() => forgetSettledOperation(storage, next)).toThrow();
  expect([...storage.values.values()].join()).not.toContain("f".repeat(64));
  expect(() => retainContextContinuation(storage, scope, { ...continuation, botRef: `bot:${scope.installationId}:${randomUUID()}` })).toThrow();
  expect(localOperations(storage, scope)[0]).toEqual(next);
  const before = [...storage.values.values()];
  expect(() => retainContextContinuation({ ...storage, setItem() {} }, scope, { ...continuation, requestId: randomUUID() })).toThrow();
  expect([...storage.values.values()]).toEqual(before);
  expect(contextLocalState("cancelled")).toBe("retired"); expect(contextLocalState("unknown")).toBe("unknown");
});

test("compaction recovery preserves only the original domain locator and cannot rebind another context request", () => {
  const storage = memoryStorage(), account = "b".repeat(64), botRef = `bot:${scope.installationId}:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`, requestId = randomUUID();
  const input = { requestId, botRef, scopeId: account, expectedRevision: "e".repeat(64), confirmed: true as const };
  const row = rememberOperation(storage, scope, input);
  expect(operationSearch(row)).toMatchObject({ domain: "compaction", requestId, scopeId: account });
  expect([...storage.values.values()].join()).not.toMatch(/expectedRevision|approval|confirmed|budget|summary|csrf/);
  markOperation(storage, row, compactionLocalState("unknown")); expect(() => forgetSettledOperation(storage, row)).toThrow();
  const next = retainCompactionContinuation(storage, scope, { requestId, botRef, scopeId: account, action: "reconcile", confirmed: true });
  expect(next.createdAt).toBe(row.createdAt); expect(next.state).toBe("awaiting-response");
  expect(() => retainContextContinuation(storage, scope, { requestId, botRef, scopeId: account, action: "cancel", confirmed: true })).toThrow();
  expect(localOperations(storage, scope)).toEqual([next]);
  expect(compactionLocalState("admitted")).toBe("unknown"); expect(compactionLocalState("completed")).toBe("succeeded");
  expect(compactionLocalState("cancelled")).toBe("retired"); expect(compactionLocalState("failed")).toBe("refused");
  markOperation(storage, next, compactionLocalState("cancelled")); forgetSettledOperation(storage, next); expect(localOperations(storage, scope)).toEqual([]);
});

test("handover locators keep the original replacement but never an attestation or deletion approval",()=>{
  const storage=memoryStorage(),id=randomUUID(),account="b".repeat(64),target=`handover:${scope.installationId}:${account}:${randomUUID()}`;
  const row=rememberOperation(storage,scope,{requestId:id,handoverRef:target,action:"retire",expectedRevision:"f".repeat(64),evidenceRef:`handover-operation:${scope.installationId}:${account}:${randomUUID()}`,confirmed:true});
  expect(operationSearch(row)).toMatchObject({domain:"handover",scopeId:account,requestId:id});expect(row.target).toBe(target);
  expect([...storage.values.values()].join()).not.toMatch(/evidenceRef|expectedRevision|confirmed|"action"|"retire"/);
  markOperation(storage,row,handoverLocalState("unknown"));expect(()=>forgetSettledOperation(storage,row)).toThrow();
  const continuation={requestId:id,scopeId:account,action:"reconcile" as const,confirmed:true as const};
  const next=retainHandoverContinuation(storage,scope,continuation,target);expect(next.createdAt).toBe(row.createdAt);
  expect(()=>retainHandoverContinuation(storage,scope,continuation,`handover:${scope.installationId}:${account}:${randomUUID()}`)).toThrow();
  expect(localOperations(storage,scope)[0]).toEqual(next);markOperation(storage,next,handoverLocalState("cancelled"));forgetSettledOperation(storage,next);expect(localOperations(storage,scope)).toEqual([]);
});

test("unknown locators are retained; only explicit settled locator removal is allowed", () => {
  const storage = memoryStorage(), row = rememberOperation(storage, scope, request());
  expect(() => forgetSettledOperation(storage, row)).toThrow();
  markOperation(storage, row, "unknown");
  expect(() => forgetSettledOperation(storage, row)).toThrow();
  markOperation(storage, row, "succeeded");
  forgetSettledOperation(storage, row);
  expect(localOperations(storage, scope)).toEqual([]);
});

test("capacity refuses new submissions without evicting unresolved records", () => {
  const storage = memoryStorage();
  for (let index = 0; index < 128; index++) rememberOperation(storage, scope, request());
  expect(() => rememberOperation(storage, scope, request())).toThrow();
  expect(localOperations(storage, scope)).toHaveLength(128);
});

test("unavailable, corrupt, or non-durable local storage refuses before a request can be sent", () => {
  const storage = memoryStorage();
  const row = rememberOperation(storage, scope, request());
  const key = storage.key(0)!;
  storage.setItem(key, "not-json");
  expect(() => localOperations(storage, scope)).toThrow();
  expect(() => rememberOperation(storage, scope, request())).toThrow();
  expect(storage.getItem(key)).toBe("not-json");
  const noWrite = { ...memoryStorage(), setItem: () => undefined };
  expect(() => rememberOperation(noWrite, scope, request())).toThrow();
  const unavailable = { ...memoryStorage(), getItem: () => { throw Error("private-storage-diagnostic"); } };
  expect(() => rememberOperation(unavailable, scope, request())).toThrow(/无法保存操作恢复标识/);
  expect(row.requestId).toBeDefined();
});

test("incident recovery stores the database locator but never the action payload or deadline", () => {
  const storage = memoryStorage(), databaseId = randomUUID(), incidentId = randomUUID();
  const input = { requestId: randomUUID(), incidentRef: `incident:${scope.installationId}:${databaseId}:${incidentId}`,
    expectedRevision: 17, action: "snooze" as const, untilMs: Date.now() + 60000 };
  const row = rememberOperation(storage, scope, input);
  expect(row).toMatchObject({ databaseId, command: "incident-snooze", target: input.incidentRef });
  expect(operationSearch(row)).toEqual({ domain: "incident", databaseId, requestId: input.requestId });
  expect(localOperations(storage, scope)).toEqual([row]);
  const serialized = storage.getItem(storage.key(0)!)!;
  expect(serialized).not.toMatch(/untilMs|expectedRevision|csrf|cookie/);
  markOperation(storage, row, "unknown"); expect(() => forgetSettledOperation(storage, row)).toThrow();
  const malicious = { ...row, databaseId: randomUUID() };
  storage.setItem(storage.key(0)!, JSON.stringify(malicious));
  expect(() => localOperations(storage, scope)).toThrow();
});

test("receiver and optional test locators preserve distinct recovery domains without storing consent input or reviewed model", () => {
  const storage = memoryStorage(), databaseId = randomUUID(), receiverRef = `receiver:${scope.installationId}:${databaseId}:${randomUUID()}`;
  for (const action of ["enable", "test"] as const) {
    const input = { requestId: randomUUID(), receiverRef, expectedRevision: 7, confirmed: true as const, action, expectedModelRevision: "b".repeat(64) };
    const row = rememberOperation(storage, scope, input);
    expect(operationSearch(row)).toEqual({ domain: action === "test" ? "notification-test" : "receiver", databaseId, requestId: input.requestId });
    expect(row.target).toBe(receiverRef); markOperation(storage, row, "unknown"); expect(() => forgetSettledOperation(storage, row)).toThrow();
  }
  expect(localOperations(storage, scope)).toHaveLength(2);
  const serialized = [...storage.values.values()].join("\n");
  expect(serialized).not.toMatch(/expectedModelRevision|expectedRevision|confirmed|csrf|cookie/);
  expect(serialized).not.toContain("b".repeat(64));
});

test("setup locators retain only their original domain and target, not blueprints, input revisions or credentials",()=>{
  const storage=memoryStorage(),botId=randomUUID(),botRef=`bot:${scope.installationId}:${botId}`,routineRef=`routine:${scope.installationId}:${botId}:one`;
  const routine=rememberOperation(storage,scope,{action:"apply",botRef,expectedRevision:null,confirmed:true,requestId:randomUUID(),blueprint:{schemaVersion:1,key:"one",name:"One",prompt:"PRIVATE_BLUEPRINT_CONTENT",isEnabled:false,trigger:{type:"webhook"}}});
  const bind=rememberOperation(storage,scope,{action:"bind",alias:"default",routineRef,databaseId:randomUUID(),expectedRevision:"b".repeat(64),expectedBindingRevision:0,confirmed:true,requestId:randomUUID()});
  expect(operationSearch(routine)).toMatchObject({domain:"routine",bot:botId,requestId:routine.requestId});
  expect(operationSearch(bind)).toMatchObject({domain:"pairing",requestId:bind.requestId});
  expect(localOperations(storage,scope)).toHaveLength(2);
  expect([...storage.values.values()].join("\n")).not.toMatch(/PRIVATE_BLUEPRINT_CONTENT|blueprint|expectedRevision|expectedBindingRevision|confirmed/);
  expect(()=>rememberOperation(storage,scope,{action:"reconcile",routineRef,expectedRevision:"b".repeat(64),confirmed:true,requestId:randomUUID()})).toThrow();
  const key=storage.key(0)!;storage.setItem(key,JSON.stringify({...routine,setupScope:randomUUID()}));expect(()=>localOperations(storage,scope)).toThrow();
});

test("material recovery retains only the scoped document locator even for long Unicode paths",()=>{
  const storage=memoryStorage(),ref=materialReference(scope.installationId,"a".repeat(64),"documents",`${"长".repeat(70)}/${"文".repeat(60)}.md`);
  const input={requestId:randomUUID(),ref,expectedRevision:"b".repeat(64),content:"PRIVATE_SOURCE_BODY",confirmed:true as const};
  const row=rememberOperation(storage,scope,input);expect(operationSearch(row)).toMatchObject({domain:"material",requestId:input.requestId});
  expect(localOperations(storage,scope)).toEqual([row]);expect([...storage.values.values()].join("")).not.toMatch(/PRIVATE_SOURCE_BODY|expectedRevision|confirmed/);
  markOperation(storage,row,"unknown");expect(()=>forgetSettledOperation(storage,row)).toThrow();
});

test("protection locators retain original targets but never a reusable policy payload",()=>{
  const storage=memoryStorage(),bot=`bot:${scope.installationId}:${randomUUID()}`;
  const input={requestId:randomUUID(),expectedRevision:"d".repeat(64),confirmed:true as const,action:"set" as const,botRef:bot,patch:{mode:"auto-replace" as const,pauseOnOwnershipLoss:false}};
  const row=rememberOperation(storage,scope,input);expect(operationSearch(row)).toMatchObject({domain:"protection",target:bot,requestId:input.requestId});
  expect(localOperations(storage,scope)).toEqual([row]);expect([...storage.values.values()].join("")).not.toMatch(/auto-replace|pauseOnOwnershipLoss|expectedRevision|confirmed/);
  markOperation(storage,row,"unknown");expect(()=>forgetSettledOperation(storage,row)).toThrow();
});

test("losing a later local status update does not erase the original recoverable request", () => {
  const storage = memoryStorage(), row = rememberOperation(storage, scope, request());
  const broken = { ...storage, setItem: () => { throw Error("storage-full"); } };
  expect(() => markOperation(broken, row, "succeeded")).not.toThrow();
  expect(localOperations(storage, scope)[0]).toEqual(row);
});
