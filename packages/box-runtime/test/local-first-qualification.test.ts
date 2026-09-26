import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { randomUUID } from "node:crypto";
import ts from "typescript";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import { createLocalFirstBridge, HOST_LOCAL_FIRST_SYMBOL } from "../src/internal/host/local-first.ts";
import { LOCAL_FIRST_SLICES } from "../src/internal/host/local-first-slices.ts";
import { transformUnchecked } from "../src/internal/host/profile.ts";
import { readNativeSource } from "./native-host-source.ts";

const nativeTest = test.skipIf(process.env.GROKBOX_TEST_NATIVE_HOST !== "1");
/** Retained/current source is read-only. Only selected original declarations run
 * in a VM with synthetic IO; neither full Host, account nor model is loaded. */
nativeTest("Local-first recipe executes original factory/registrar/writer with one Box request and unchanged native ownership", async () => {
  const source = readNativeSource("source").toString("utf8"), patched = transformUnchecked(source, LOCAL_FIRST_SLICES);
  expect(patched.ok).toBe(true); if (!patched.ok) throw Error(patched.code);
  const hashes: Record<string, string> = {};
  const select = (text: string, name: string, start: string, end = "\n  }\n") => {
    const begin = text.indexOf(start), last = text.indexOf(end, begin + start.length);
    if (begin < 0 || text.indexOf(start, begin + 1) >= 0 || last < 0 || last - begin > 32768) throw Error("local_first_native_role_ambiguous");
    const code = text.slice(begin, end === "\n  }\n" ? last + end.length : last);
    hashes[name] = sha256Text(code); return code;
  };
  const mint = select(patched.source, "gateway-mint", "  const mintAgent = async (args) => {", "  const deleteAgentsAndReport = async (ids) => {");
  const methods = [
    ["ensure", "  ensureServerBacked(agentId) {"], ["request", '  async requestMint(create, request5, reportOp = "mint") {'],
    ["factory", '  async createBackgroundAgent(profile, origin = "user", options2 = {}) {'], ["session", "  async mintAgentSession(profile, origin, options2) {"],
  ].map(([name, start]) => select(patched.source, name!, start!)).join("\n");
  const parsed = ts.createSourceFile("selected.js", `${mint}\nclass Selected {${methods}}`, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  expect((parsed as any).parseDiagnostics).toHaveLength(0);
  // Finite role/field checks on the original registrar. A matching string in a
  // comment, nested decoy or overwritten field cannot stand in for this call.
  const ensure = (parsed.statements.find(ts.isClassDeclaration)!).members.find(member => ts.isMethodDeclaration(member) && member.name.getText(parsed) === "ensureServerBacked") as ts.MethodDeclaration;
  const awaitedMints: ts.CallExpression[] = [], stamps: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isAwaitExpression(node) && ts.isCallExpression(node.expression) && node.expression.expression.getText(parsed) === "this.requestMint") awaitedMints.push(node.expression);
    if (ts.isCallExpression(node) && node.expression.getText(parsed) === "this.stampFromRemote") stamps.push(node);
    ts.forEachChild(node, visit);
  };
  visit(ensure);
  expect(awaitedMints).toHaveLength(1); expect(stamps).toHaveLength(1);
  const [transport, fields] = awaitedMints[0]!.arguments;
  expect(transport!.getText(parsed)).toBe("create"); expect(ts.isObjectLiteralExpression(fields!)).toBe(true);
  const props = (fields as ts.ObjectLiteralExpression).properties;
  expect(props.filter(p => ts.isPropertyAssignment(p) && p.name.getText(parsed) === "createIntent").map(p => (p as ts.PropertyAssignment).initializer.getText(parsed))).toEqual(['"register-existing-local"']);
  expect(props.filter(p => ts.isPropertyAssignment(p) && p.name.getText(parsed) === "createCaller").map(p => (p as ts.PropertyAssignment).initializer.getText(parsed))).toEqual(['"ensure-server-backed"']);
  expect(props.some(p => ts.isShorthandPropertyAssignment(p) && p.name.text === "agentId")).toBe(true);
  expect(stamps[0]!.arguments.map(a => a.getText(parsed))).toEqual(["agentId", "profilePath", "confirmed", "identity"]);
  expect(stamps[0]!.pos).toBeGreaterThan(awaitedMints[0]!.pos);
  const calls: string[] = [], requests: any[] = [], profiles = new Map<string, any>(), locals = new Map<string, any>();
  let fail = false, temporal = false;
  const bridge = createLocalFirstBridge({ sourceSha256: sha256Text(source), transformedSha256: sha256Text(patched.source), profileSha256: "d".repeat(64), preloadSha256: "e".repeat(64), generationId: "isolated-native" });
  const Selected = runInNewContext(`(class {${methods}})`, {
    [Symbol.for(HOST_LOCAL_FIRST_SYMBOL)]: bridge,
    readSandProfileServerId: (id: string) => profiles.get(id)?.serverId ?? null,
    readSandProfileHarness: (id: string) => profiles.get(id)?.harness ?? null,
    readSandProfileFile: (id: string) => profiles.get(id),
    withGeneratedMark: (_id: string, fields: any) => fields, identityInput: (fields: any) => fields,
    toRemoteGrokBotAgent: (a: any) => a && ({ handle: a.agentId, serverId: a.id, harness: a.harness }),
    invariant: (ok: boolean) => { if (!ok) throw Error("native_invariant"); }, AGENT_IDENTITY_SYNC_ERROR_CODE: "synthetic",
    SandAgentLifecycleError: Error,
  });
  const identity = new Selected(); identity.profilePathFor = (id: string) => id;
  identity.runSerialized = (fn: () => unknown) => fn(); identity.isWriteEnabled = async () => true;
  identity.readLocalAvatarForUpload = async () => undefined; identity.rememberLocalAvatarIfItDoesNotMatchRow = async () => {};
  identity.stampFromRemote = (id: string, _path: string, r: any) => { calls.push("native-stamp"); Object.assign(profiles.get(id), { serverId: r.serverId, harness: r.harness }); };
  identity.deps = { isSharedIdentityEnabled: () => true, report() {}, retry: { runWithRetry() { throw Error("local_creation_must_not_retry"); } },
    createRemoteAgent: async (q: any) => { calls.push("server"); requests.push(q); if (fail) throw Error("synthetic_lost_reply");
      return { outcome: "created", agent: { agentId: q.agentId, id: `server-${q.agentId}`, harness: temporal ? "temporal" : "box" } }; } };
  const manager = new Selected(); manager.tm = { sessionStore: {
    createSession: async (p: any, origin: string, options: any) => {
      calls.push("local"); expect(options.serverId).toBeUndefined(); expect(options.harness).toBeUndefined(); expect(origin).toBe("user");
      const id = randomUUID(); profiles.set(id, { ...p }); const session = { id,
        db: { getTranscriptEntries: () => [], close() { calls.push("close"); }, setIntroductionPending() { throw Error("unexpected_introduction"); } },
        agentStore: { dispose: async () => calls.push("dispose") } };
      locals.set(id, session); return session;
    }, summarizeOpenSession: async (s: any) => ({ id: s.id, ...profiles.get(s.id), isGroup: false }),
  }, roster: { emitAgents: async () => {}, reserveSnapshotStamp: () => 1, finalizeSummaryForRpc: (row: any) => row } };
  manager.listAgents = async () => [...profiles.entries()].map(([id, p]) => ({ id, ...p, isGroup: false }));
  const mintAgent = runInNewContext(`(manager, deps) => {${mint}; return mintAgent;}`, { [Symbol.for(HOST_LOCAL_FIRST_SYMBOL)]: bridge,
    isSandAgentPurpose: () => false }) (manager, { extensions: { api: () => identity } });
  for (const mode of ["box", "temporal", "lost"] as const) {
    temporal = mode === "temporal"; fail = mode === "lost";
    const args = { name: "Isolated native fixture", description: "", clientNonce: randomUUID(), harness: "box", isIntroductionSuppressed: true, isKickstartRequested: false };
    const result = await mintAgent(args), r = result.grokboxCreation;
    expect(r.localAgentId).toBe(result.agent.id); expect(r.request.agentId).toBe(result.agent.id);
    expect(r.outcome).toBe(mode === "box" ? "registered" : mode === "temporal" ? "mismatch" : "unknown");
    expect(requests.at(-1)).toMatchObject({ harness: "box", introductionSuppressed: true, kickstartRequested: false,
      createCaller: "ensure-server-backed", createIntent: "register-existing-local" });
    expect(profiles.get(result.agent.id).harness).toBe(mode === "lost" ? undefined : mode);
    const count = requests.length; await mintAgent(args); expect(requests.length).toBe(count);
  }
  expect(calls.filter(c => c === "local")).toHaveLength(3); expect(calls.filter(c => c === "server")).toHaveLength(3);
  expect(calls.slice(0, 5)).toEqual(["local", "dispose", "close", "server", "native-stamp"]);
  console.log(JSON.stringify({ qualification: "local-first-native-declarations", sourceSha256: sha256Text(source), declarationHashes: hashes, liveEffects: false }));
});
