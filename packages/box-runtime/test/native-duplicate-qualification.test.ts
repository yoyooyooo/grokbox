import { expect, test } from "bun:test";
import { readNativeSource } from "./native-host-source.ts";
import { posix } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import { HOST_RECIPE } from "../src/internal/host/source-recipes.ts";
import { nativeContinuityEnabled, CONT_NATIVE_PAIR } from "./native-continuity-code.ts";

const nativeTest = test.skipIf(!nativeContinuityEnabled());
function bundle() {
  // A failed qualification must not cache bytes that later test cases can use.
  // Each independent selection checks the source actually read in this window.
  const source = readNativeSource("source").toString("utf8");
  expect(sha256Text(source)).toBe(CONT_NATIVE_PAIR.host);
  return source;
}
function selected(name: string) {
  const text = bundle(), marker = `\nfunction ${name}(`, begin = text.indexOf(marker);
  if (begin < 0 || text.indexOf(marker, begin + 1) >= 0) throw Error("native-duplicate-declaration-ambiguous");
  const end = text.indexOf("\n}", begin);
  if (end < 0 || end - begin > 32000) throw Error("native-duplicate-layout-changed");
  const code = text.slice(begin + 1, end + 2);
  const parsed = ts.createSourceFile("selected.js", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (parsed.statements.length !== 1 || !ts.isFunctionDeclaration(parsed.statements[0]!) || parsed.statements[0]!.name?.text !== name) throw Error("native-duplicate-invalid-declaration");
  return code;
}
function fixture(patched = false) {
  const sourceDir = "/owned/source", targetDir = "/owned/target", files = new Map<string,string>([
    [sourceDir + "/store.db", "synthetic-store"], [sourceDir + "/settings.json", "synthetic-settings"],
    [sourceDir + "/conversation-blobs.db", "native-context"], [sourceDir + "/memory/profile.md", "private-memory"],
    [sourceDir + "/automations/daily/automation.json", '{"isEnabled":true}'],
  ]);
  const recorded: string[] = [], profiles = new Map<string,unknown>(), metadata = new Map<string,unknown>([["grokbox.current-state.v1", "source-prepared-state"]]);
  const originals = ["cloneStoreDb", "writeClonedProfile", "cloneAutomations", "rewriteClonedAgentIdentity", "copyIfPresent", "cloneAgentDir"].map(selected);
  if (patched) {
    const patch = HOST_RECIPE.currentState.find(slice => slice.id === "continuity-native-duplicate-identity")!;
    originals[3] = originals[3]!.replace(patch.find, patch.replacement);
  }
  const globals = { import_node_fs80: {
    mkdirSync: () => undefined,
    existsSync: (p: string) => files.has(p),
    copyFileSync: (a: string,b: string) => { if (!files.has(a)) throw Error("fake-file-missing"); recorded.push(`copy:${a}`); files.set(b, files.get(a)!); },
    rmSync: () => { recorded.push("rollback"); },
  }, import_node_path129: posix, STORE_FILENAME: "store.db", CANONICAL_AVATAR_FILENAME: "avatar.png", AUTOMATION_CONFIG_FILENAME2: "automation.json",
    checkpointSandAgentDb: (path: string) => { recorded.push(`checkpoint:${path}`); },
    getSandProfilePath: (p: string) => p + "/profile.json", getSandSettingsPath: (p: string) => p + "/settings.json",
    getAgentAutomationsDir: (p: string) => p + "/automations",
    listAgentAutomationConfigFiles: () => [{ folderName: "daily", configPath: sourceDir + "/automations/daily/automation.json" }],
    writeSandProfileFile: (p: string,value: unknown) => { profiles.set(p, value); },
    writeSandSettingsFile: (p: string,value: unknown) => { profiles.set(p, value); },
    cloneAvatarFiles: () => { recorded.push("avatars"); }, SandAgentCloneError: Error,
  };
  const createDb = () => ({ set: (k:string,v:unknown) => metadata.set(k,v), setAgentOrigin: (v:string) => metadata.set("origin",v),
    clearAgentPurpose: () => recorded.push("clear-purpose"), clearTransientState: () => recorded.push("clear-transient"),
    clearConversation: () => recorded.push("clear-conversation"), deleteKv: (key:string) => metadata.delete(key), readKv: (key:string) => metadata.get(key) ?? null,
    getSandProfile: () => ({ description:"role" }), setSandProfile: () => recorded.push("profile-db"), close: () => recorded.push("closed") });
  const run = runInNewContext(`${originals.join("\n")}\ncloneAgentDir`, globals, { timeout:1000, contextCodeGeneration:{ strings:false, wasm:false } });
  const cloneProfile = { name: "native-name", description: "clone-role", title: "clone-title", avatarShape: "square", avatarColor: "blue" };
  return { run: () => run(sourceDir,targetDir,"new-id",cloneProfile,createDb), files, profiles, recorded, metadata, sourceDir,targetDir,cloneProfile };
}

nativeTest("current official duplicate clears the conversation and copies enabled local Routine bytes, not full context or Memory", () => {
  const f = fixture(); f.run();
  expect(f.recorded).toContain("clear-conversation"); expect(f.recorded).toContain("clear-transient");
  expect(f.recorded.indexOf(`checkpoint:${f.sourceDir}/store.db`)).toBeLessThan(f.recorded.indexOf(`copy:${f.sourceDir}/store.db`));
  expect(f.files.get(f.targetDir + "/automations/daily/automation.json")).toBe('{"isEnabled":true}');
  expect(f.files.has(f.targetDir + "/conversation-blobs.db")).toBe(false);
  expect(f.files.has(f.targetDir + "/memory/profile.md")).toBe(false);
  expect(f.profiles.get(f.targetDir + "/settings.json")).toEqual({ hiddenFromSidebar:false });
  expect(f.profiles.get(f.targetDir + "/profile.json")).toEqual({ ...f.cloneProfile, namedBy: expect.any(String) });
  expect(f.profiles.get(f.targetDir + "/profile.json")).not.toHaveProperty("serverId");
  expect(f.profiles.get(f.targetDir + "/profile.json")).not.toHaveProperty("harness");
  expect(f.metadata.get("agentId")).toBe("new-id");
});

nativeTest("current-state identity-cleanup slice removes the source hold from an official duplicate without changing official conversation reset", () => {
  const baseline = fixture(); baseline.run(); expect(baseline.metadata.has("grokbox.current-state.v1")).toBe(true);
  const patched = fixture(true); patched.run();
  expect(patched.metadata.has("grokbox.current-state.v1")).toBe(false);
  expect(patched.recorded).toContain("clear-conversation");
  expect(patched.files.get(patched.targetDir + "/automations/daily/automation.json")).toBe('{"isEnabled":true}');
});

function lifecycleFixture() {
  const text = bundle(), marker = "\n  async cloneAgent(sourceId, provision) {", start = text.indexOf(marker);
  const end = text.indexOf("\n  }", start + marker.length);
  if (start < 0 || text.indexOf(marker, start + marker.length) !== -1 || end < 0 || end-start>8000) throw Error("native-duplicate-method-changed");
  const code = `(class {${text.slice(start + 1,end + 4)}})`;
  const parsed = ts.createSourceFile("selected-lifecycle.js", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const statement = parsed.statements[0];
  const owner = statement && ts.isExpressionStatement(statement) && ts.isParenthesizedExpression(statement.expression) ? statement.expression.expression : undefined;
  if ((parsed as unknown as { parseDiagnostics: readonly unknown[] }).parseDiagnostics.length || parsed.statements.length !== 1
    || !owner || !ts.isClassExpression(owner) || owner.members.length !== 1) throw Error("native-duplicate-method-invalid");
  const method = owner.members[0]!;
  if (!ts.isMethodDeclaration(method) || method.name.getText(parsed) !== "cloneAgent"
    || method.parameters.map(parameter => parameter.name.getText(parsed)).join(",") !== "sourceId,provision") throw Error("native-duplicate-method-invalid");
  const copies: unknown[][] = [], writes: unknown[][] = [], mintedIds: (string | undefined)[] = [], events: string[] = [];
  const state = { group: false, exists: true, commits: 0, writeFailure: undefined as unknown };
  const sourceProfile = { name: "source", description: "role", title: "title", avatarShape: "square", avatarColor: "green" };
  const Native = runInNewContext(code, { SandAgentLifecycleError:Error, cloneAgentDisplayName:(name:string) => name+" copy",
    getSandProfilePath:(dir:string) => dir+"/profile.json",
    writeServerBackedProfileFile:(...args:unknown[]) => { events.push("write-profile"); writes.push(args); if (state.writeFailure) throw state.writeFailure; },
  }, { timeout:1000 });
  const original = new Native(); original.tm={ sessionStore:{ listAgents:async()=> state.exists ? [{id:"old",...sourceProfile,isGroup:state.group}] : [],
    mintAgent:async (body:(id:string)=>unknown,id?:string)=>{ events.push("mint"); mintedIds.push(id); return body(id ?? "new"); },
    getAgentDir:(id:string)=>`/owned/${id}`, cloneAgentDir:(...args:unknown[])=>{ events.push("copy"); copies.push(args); } } };
  original.openMintedSession=async (id:string)=>{ events.push("open"); return {agent:{id}}; };
  original.commitOpenedSession=async (value:unknown)=>{ events.push("commit"); state.commits++; return value; };
  return { original, state, sourceProfile, copies, writes, mintedIds, events };
}

nativeTest("official lifecycle rejects groups and missing sources, then delegates a new identity and native active-session commit", async () => {
  const f = lifecycleFixture(); let provisions=0;
  const provision=async()=>{ provisions++; throw Error("must-not-provision"); };
  f.state.exists=false; await expect(f.original.cloneAgent("old", provision)).rejects.toThrow();
  f.state.exists=true; f.state.group=true; await expect(f.original.cloneAgent("old", provision)).rejects.toThrow();
  expect(f.mintedIds).toHaveLength(0); expect(provisions).toBe(0); f.state.group=false;
  expect(await f.original.cloneAgent("old")).toEqual({agent:{id:"new"}});
  expect(f.mintedIds).toEqual([undefined]); expect(f.state.commits).toBe(1);
  expect(f.copies).toEqual([["/owned/old","/owned/new","new",{...f.sourceProfile,name:"source copy"}]]);
  expect(f.writes).toEqual([]); expect(f.events).toEqual(["mint","copy","open","commit"]);
});

nativeTest("official duplicate awaits provision and preserves its assigned identity through profile publication and session commit", async () => {
  const f = lifecycleFixture(), entered = Promise.withResolvers<void>();
  const binding = { agentId: "assigned", serverId: "owned-server", avatarShape: "circle", avatarColor: "blue" };
  const ready = Promise.withResolvers<typeof binding>(); let requested: unknown;
  const running = f.original.cloneAgent("old", async (input:unknown) => { f.events.push("provision"); requested=input; entered.resolve(); return ready.promise; });
  await entered.promise;
  expect(requested).toMatchObject({agent:{id:"old"},profile:{...f.sourceProfile,name:"source copy"}});
  expect(f.events).toEqual(["provision"]); expect(f.mintedIds).toHaveLength(0); expect(f.state.commits).toBe(0);
  ready.resolve(binding);
  expect(await running).toEqual({agent:{id:"assigned"}});
  const cloneProfile = {...f.sourceProfile,name:"source copy",avatarShape:binding.avatarShape,avatarColor:binding.avatarColor};
  expect(f.mintedIds).toEqual(["assigned"]);
  expect(f.copies).toEqual([["/owned/old","/owned/assigned","assigned",cloneProfile]]);
  expect(f.writes).toHaveLength(1);
  expect(f.writes[0]).toMatchObject(["/owned/assigned/profile.json",{...cloneProfile,namedBy:expect.any(String)},{serverId:"owned-server"}]);
  expect(f.events).toEqual(["provision","mint","copy","write-profile","open","commit"]); expect(f.state.commits).toBe(1);
});

for (const failureAt of ["provision", "profile-write"] as const) nativeTest(`official duplicate ${failureAt} failure preserves the error without committing an opened session`, async () => {
  const f = lifecycleFixture(), failure = { owned: failureAt };
  if (failureAt === "profile-write") f.state.writeFailure=failure;
  await expect(f.original.cloneAgent("old", async () => {
    f.events.push("provision"); if (failureAt === "provision") throw failure;
    return {agentId:"assigned",serverId:"owned-server",avatarShape:"circle",avatarColor:"blue"};
  })).rejects.toBe(failure);
  expect(f.state.commits).toBe(0); expect(f.events).not.toContain("open");
  expect(f.mintedIds).toEqual(failureAt === "provision" ? [] : ["assigned"]);
  expect(f.writes).toHaveLength(failureAt === "provision" ? 0 : 1);
});
