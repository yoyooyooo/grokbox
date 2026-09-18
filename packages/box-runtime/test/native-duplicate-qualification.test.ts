import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import { NATIVE_CHECKPOINT_PAIR } from "../src/internal/host/native-checkpoint-worker-hook.ts";
import { NATIVE_CURRENT_STATE_SLICES } from "../src/internal/host/native-current-state-slices.ts";
import { nativeContinuityEnabled } from "./native-continuity-code.ts";

const nativeTest = test.skipIf(!nativeContinuityEnabled());
let source: string | undefined;
function bundle() {
  if (source === undefined) {
    source = readFileSync("/home/box/sand-host/host-main.cjs", "utf8");
    expect(sha256Text(source)).toBe(NATIVE_CHECKPOINT_PAIR.host);
  }
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
    const patch = NATIVE_CURRENT_STATE_SLICES.find(slice => slice.id === "continuity-native-duplicate-identity")!;
    originals[3] = originals[3]!.replace(patch.find, patch.replacement);
  }
  const globals = { import_node_fs77: {
    mkdirSync: () => undefined,
    existsSync: (p: string) => files.has(p),
    copyFileSync: (a: string,b: string) => { if (!files.has(a)) throw Error("fake-file-missing"); recorded.push(`copy:${a}`); files.set(b, files.get(a)!); },
    rmSync: () => { recorded.push("rollback"); },
  }, import_node_path127: posix, STORE_FILENAME: "store.db", CANONICAL_AVATAR_FILENAME: "avatar.png", AUTOMATION_CONFIG_FILENAME2: "automation.json",
    checkpointSandAgentDb: (path: string) => { recorded.push(`checkpoint:${path}`); },
    getSandProfilePath: (p: string) => p + "/profile.json", getSandSettingsPath: (p: string) => p + "/settings.json",
    getAgentAutomationsDir: (p: string) => p + "/automations",
    listAgentAutomationConfigFiles: () => [{ folderName: "daily", configPath: sourceDir + "/automations/daily/automation.json" }],
    readSandProfileFile: () => ({ name: "source", description: "role", title: "title", serverId: "OLD-ID", harness: "temporal" }),
    writeSandProfileFile: (p: string,value: unknown) => { profiles.set(p, value); },
    writeSandSettingsFile: (p: string,value: unknown) => { profiles.set(p, value); },
    cloneAvatarFiles: () => { recorded.push("avatars"); }, SandAgentCloneError: Error,
  };
  const createDb = () => ({ set: (k:string,v:unknown) => metadata.set(k,v), setAgentOrigin: (v:string) => metadata.set("origin",v),
    clearAgentPurpose: () => recorded.push("clear-purpose"), clearTransientState: () => recorded.push("clear-transient"),
    clearConversation: () => recorded.push("clear-conversation"), deleteKv: (key:string) => metadata.delete(key), readKv: (key:string) => metadata.get(key) ?? null,
    getSandProfile: () => ({ description:"role" }), setSandProfile: () => recorded.push("profile-db"), close: () => recorded.push("closed") });
  const run = runInNewContext(`${originals.join("\n")}\ncloneAgentDir`, globals, { timeout:1000, contextCodeGeneration:{ strings:false, wasm:false } });
  return { run: () => run(sourceDir,targetDir,"new-id","native-name",createDb), files, profiles, recorded, metadata, sourceDir,targetDir };
}

nativeTest("current official duplicate clears the conversation and copies enabled local Routine bytes, not full context or Memory", () => {
  const f = fixture(); f.run();
  expect(f.recorded).toContain("clear-conversation"); expect(f.recorded).toContain("clear-transient");
  expect(f.recorded.indexOf(`checkpoint:${f.sourceDir}/store.db`)).toBeLessThan(f.recorded.indexOf(`copy:${f.sourceDir}/store.db`));
  expect(f.files.get(f.targetDir + "/automations/daily/automation.json")).toBe('{"isEnabled":true}');
  expect(f.files.has(f.targetDir + "/conversation-blobs.db")).toBe(false);
  expect(f.files.has(f.targetDir + "/memory/profile.md")).toBe(false);
  expect(f.profiles.get(f.targetDir + "/settings.json")).toEqual({ hiddenFromSidebar:false });
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

nativeTest("official lifecycle rejects groups and missing sources, then delegates a new identity and native active-session commit", async () => {
  const text = bundle(), start = text.indexOf("  async cloneAgent(sourceId) {"), end = text.indexOf("  async commitOpenedSession(", start);
  if (start < 0 || end < 0 || end-start>8000) throw Error("native-duplicate-method-changed");
  const Native = runInNewContext(`(class {${text.slice(start,end)}})`, { SandAgentLifecycleError:Error, cloneAgentDisplayName:(name:string) => name+" copy" }, { timeout:1000 });
  let minted=0, commits=0, group=false, exists=true; const copies:unknown[]=[];
  const original = new Native(); original.tm={ sessionStore:{ listAgents:async()=> exists ? [{id:"old",name:"source",isGroup:group}] : [],
    mintAgent:async (body:(id:string)=>unknown)=>{ minted++; return body("new"); },
    getAgentDir:(id:string)=>`/owned/${id}`, cloneAgentDir:(...args:unknown[])=>copies.push(args) } };
  original.openMintedSession=async (id:string)=>({agent:{id}});
  original.commitOpenedSession=async (value:unknown)=>{ commits++; return value; };
  exists=false; await expect(original.cloneAgent("old")).rejects.toThrow();
  exists=true; group=true; await expect(original.cloneAgent("old")).rejects.toThrow();
  expect(minted).toBe(0); group=false;
  expect(await original.cloneAgent("old")).toEqual({agent:{id:"new"}});
  expect(minted).toBe(1); expect(commits).toBe(1); expect(copies).toEqual([["/owned/old","/owned/new","new","source copy"]]);
});
