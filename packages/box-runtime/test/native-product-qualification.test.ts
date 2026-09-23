import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import { CONT_NATIVE_PAIR, nativeContinuityEnabled } from "./native-continuity-code.ts";

const nativeTest = test.skipIf(!nativeContinuityEnabled());
/** Execute selected original declarations only. The full Host is never loaded;
 * lexical IO dependencies are finite synthetic ports, not an account or desktop.
 * Native implementation bytes remain in the installed source and ephemeral VM. */
function source() {
  const text = readFileSync("/home/box/sand-host/host-main.cjs", "utf8");
  expect(sha256Text(text)).toBe(CONT_NATIVE_PAIR.host);
  const digest: Record<string, string> = {};
  const hash = (name: string, value: string) => { digest[name] = sha256Text(value); return value; };
  const fn = (name: string, bound = 32768) => {
    const marker = `\nfunction ${name}(`, begin = text.indexOf(marker), end = text.indexOf("\n}", begin);
    if (begin < 0 || text.indexOf(marker, begin + 1) >= 0 || end < 0 || end - begin > bound) throw Error("native_product_declaration_changed");
    const code = text.slice(begin + 1, end + 2), parsed = ts.createSourceFile("selected.js", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    if (parsed.statements.length !== 1 || !ts.isFunctionDeclaration(parsed.statements[0]!) || parsed.statements[0]!.name?.text !== name) throw Error("native_product_declaration_shape");
    return hash(name, code);
  };
  const literal = (name: string) => {
    const found = [...text.matchAll(new RegExp(`\\b${name}\\s*=\\s*([0-9]+)\\s*[;,]`, "g"))];
    if (found.length !== 1 || !Number.isSafeInteger(Number(found[0]![1]))) throw Error("native_product_literal_changed");
    hash(name, found[0]![0]); return Number(found[0]![1]);
  };
  return { text, digest, hash, fn, literal };
}
function gatewayFixture() {
  const selected = source(), api = selected.fn("createHostGatewayApi", 256 * 1024);
  const sf = ts.createSourceFile("selected-api.js", api, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const names = ["createAgent", "createGroup", "updateAgent", "deleteAgent", "duplicateAgent", "setGroupMembers", "setAgentNotifyOnUpdates", "setAgentHiddenFromSidebar"];
  const members = new Map<string, string>();
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "api" && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
      for (const member of node.initializer.properties) if ((ts.isPropertyAssignment(member) || ts.isMethodDeclaration(member)) && names.includes(member.name.getText(sf))) {
        const name = member.name.getText(sf); if (members.has(name)) throw Error("native_product_rpc_ambiguous"); members.set(name, selected.hash(`api:${name}`, member.getText(sf)));
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf); if (members.size !== names.length) throw Error("native_product_rpc_missing");
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const response = { agent: { id: "synthetic-created" }, transcript: [] };
  const manager = Object.fromEntries(["createGroup", "updateAgent", "cloneAgent", "setGroupMembers", "setAgentNotifyOnUpdates", "setAgentHiddenFromSidebar"].map(method =>
    [method, async (...args: unknown[]) => { calls.push({ method, args }); return response; }]));
  let failed = false;
  const make = runInNewContext(`(manager, deps, writeLocalProfile, deleteAgentsAndReport, mintAgent) => ({${[...members.values()].join(",")}})`,
    { Map, createAgentMintsByNonce: new Map(), CREATE_AGENT_NONCE_LEDGER_CAP: selected.literal("CREATE_AGENT_NONCE_LEDGER_CAP") },
    { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } });
  const create = () => make(manager, { extensions: { api: (name: string) => {
    expect(name).toBe("agent-identity"); return { noteAgentMinted: (...args: unknown[]) => calls.push({ method: "noteAgentMinted", args }) };
  } } }, async (id: unknown, update: () => Promise<unknown>) => { calls.push({ method: "writeLocalProfile", args: [id] }); return update(); },
  async (ids: unknown) => { calls.push({ method: "deleteAgentsAndReport", args: [ids] }); return { transcript: [] }; },
  async (input: unknown) => { calls.push({ method: "mintAgent", args: [input] }); if (failed) throw Error("synthetic-mint-failure"); return response; });
  return { api: create(), calls, response, fail: () => { failed = true; }, recover: () => { failed = false; }, hashes: selected.digest };
}

nativeTest("selected current native product RPCs preserve argument shape and original lifecycle delegates", async () => {
  const f = gatewayFixture();
  await f.api.createGroup({ name: "Synthetic group", description: "description", memberAgentIds: ["a", "b"] });
  expect(f.calls.pop()).toEqual({ method: "createGroup", args: [{ name: "Synthetic group", description: "description", memberIds: ["a", "b"], namedBy: undefined }] });
  await f.api.setGroupMembers({ id: "group", memberAgentIds: ["b"] });
  expect(f.calls.pop()).toEqual({ method: "setGroupMembers", args: ["group", ["b"], {}] });
  await f.api.updateAgent({ id: "bot", profile: { title: "user" } });
  expect(f.calls.splice(0)).toEqual([{ method: "writeLocalProfile", args: ["bot"] }, { method: "updateAgent", args: ["bot", { title: "user" }] }]);
  expect(await f.api.deleteAgent({ id: "bot" })).toEqual({ transcript: [] });
  expect(f.calls.pop()).toEqual({ method: "deleteAgentsAndReport", args: [["bot"]] });
  await f.api.duplicateAgent({ id: "bot" });
  expect(f.calls.splice(0)).toEqual([{ method: "cloneAgent", args: ["bot"] }, { method: "noteAgentMinted", args: ["synthetic-created", "register-existing-local"] }]);
  await f.api.setAgentHiddenFromSidebar({ id: "bot", isHidden: true });
  await f.api.setAgentNotifyOnUpdates({ id: "bot", isEnabled: false });
  expect(f.calls.splice(0)).toEqual([{ method: "setAgentHiddenFromSidebar", args: ["bot", true] }, { method: "setAgentNotifyOnUpdates", args: ["bot", false] }]);
  console.log(JSON.stringify({ qualification: "AH-138-native-product-delegation", hostSha: CONT_NATIVE_PAIR.host, dependencyHashes: f.hashes, liveAccountEffects: false }));
});

nativeTest("the original creation nonce cache is volatile and removes failed mints, not durable retry authority", async () => {
  const f = gatewayFixture();
  const declaration = { name: "Synthetic", clientNonce: "one-original-nonce" };
  await f.api.createAgent(declaration); await f.api.createAgent(declaration);
  expect(f.calls.filter(call => call.method === "mintAgent")).toHaveLength(1);
  // A new Host API's lexical cache is empty. The management ledger must own
  // non-replay across generations, rather than depending on this native cache.
  const restarted = gatewayFixture(); await restarted.api.createAgent(declaration);
  expect(restarted.calls.filter(call => call.method === "mintAgent")).toHaveLength(1);
  f.fail(); await expect(f.api.createAgent({ ...declaration, clientNonce: "failed" })).rejects.toThrow("synthetic-mint-failure");
  f.recover(); await f.api.createAgent({ ...declaration, clientNonce: "failed" });
  expect(f.calls.filter(call => call.method === "mintAgent")).toHaveLength(3);
});

nativeTest("the original Group writer filters members, rejects migration, ignores empty replacements and has no CAS", async () => {
  const selected = source(), start = selected.text.indexOf("\n  async setGroupMembers("), end = selected.text.indexOf("\n  isGroupSession(", start);
  if (start < 0 || selected.text.indexOf("\n  async setGroupMembers(", start + 1) >= 0 || end < 0 || end - start > 32768) throw Error("native_product_membership_layout_changed");
  const code = selected.hash("native:setGroupMembers", selected.text.slice(start, end));
  const parsed = ts.createSourceFile("selected-method.js", `(class {${code}})`, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if ((parsed as any).parseDiagnostics.length) throw Error("native_product_membership_parse");
  const writes: unknown[] = []; let config: { memberIds: string[] } | null = { memberIds: ["a"] }, allowed = true;
  const rows = Array.from({ length: 9 }, (_, i) => ({ id: String(i), isGroup: false }));
  const Native = runInNewContext(`(class {${code}})`, { Set,
    GROUP_MAX_MEMBERS: selected.literal("GROUP_MAX_MEMBERS"), GROUP_CONFIG_VERSION: selected.literal("GROUP_CONFIG_VERSION"),
    SandGroupMembersUnavailableError: Error,
    // Group type validation is a lexical dependency, not an inferred CAS or
    // account privilege. Its separate implementation is not claimed here.
    assertMembersAreNotGroups: (ids: string[], isGroup: (id: string) => boolean) => { if (ids.some(isGroup)) throw Error("synthetic-group-type-refused"); },
    writeSandGroupConfig: (_dir: unknown, next: { memberIds: string[] }) => { writes.push(next); config = next; },
  }, { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } });
  const native = new Native(); native.localGroupConfig = () => config;
  native.tm = { execution: { get isLocalWorkAllowed() { return allowed; } }, sessionStore: {
    getAgentDir: () => "/synthetic/group", listAgents: async () => [...rows, { id: "group", isGroup: true, memberIds: config?.memberIds }],
  }, roster: { emitAgents: async () => undefined, reserveSnapshotStamp: () => 1, finalizeSummaryForRpc: (row: unknown) => row } };
  expect(selected.literal("GROUP_MAX_MEMBERS")).toBe(6);
  await native.setGroupMembers("group", ["0", "0", "missing", "1"]);
  expect(config!.memberIds).toEqual(["0", "1"]);
  const count = writes.length; await native.setGroupMembers("group", []); expect(writes).toHaveLength(count);
  expect(await native.setGroupMembers("group", ["2"], { requesterAgentId: "non-member" })).toBeNull(); expect(writes).toHaveLength(count);
  allowed = false; await expect(native.setGroupMembers("group", ["2"])).rejects.toThrow("upgrading or migrating"); expect(writes).toHaveLength(count); allowed = true;
  await native.setGroupMembers("group", rows.map(row => row.id)); expect(config!.memberIds).toEqual(["0", "1", "2", "3", "4", "5"]);
  // Competing observed snapshots are not a native compare-and-swap gate.
  await native.setGroupMembers("group", ["7"]); await native.setGroupMembers("group", ["8"]); expect(config!.memberIds).toEqual(["8"]);
  console.log(JSON.stringify({ qualification: "AH-138-native-group-writer", hostSha: CONT_NATIVE_PAIR.host, dependencyHashes: selected.digest, atomicCompareAndSet: false, liveAccountEffects: false }));
});
