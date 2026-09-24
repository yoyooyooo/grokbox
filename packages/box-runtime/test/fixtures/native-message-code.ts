import { createHash } from "node:crypto";
import { readNativeSource } from "../native-host-source.ts";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { CONT_NATIVE_PAIR } from "../native-continuity-code.ts";
import { OWNERSHIP_READ_SLICES } from "../../src/internal/host/ownership-slices.ts";
import { transformUnchecked } from "../../src/internal/host/profile.ts";

// Only selected declarations run in an IO-free VM. Original private bytes are
// never emitted, copied into this repository, or used as a full Host entrypoint.
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const callable = (value: unknown) => {
  if (typeof value !== "function") throw Error("native_message_callable_missing");
  return value;
};
export function nativeMessageCode(overrides: Record<string, unknown> = {}) {
  let source = readNativeSource("source").toString("utf8");
  if (createHash("sha256").update(source).digest("hex") !== CONT_NATIVE_PAIR.host) throw Error("native_message_source_mismatch");
  const patched = transformUnchecked(source, OWNERSHIP_READ_SLICES.filter(slice => slice.id === "ownership-read-api"));
  if (!patched.ok) throw Error("native_message_ownership_api_mismatch");
  source = patched.source;
  const hashes: Record<string, string> = {};
  const digest = (label: string, text: string) => { hashes[label] = createHash("sha256").update(text).digest("hex"); return text; };
  function fn(name: string) {
    const marker = "\nfunction " + name + "(", start = source.indexOf(marker);
    if (start < 0 || source.indexOf(marker, start + 1) !== -1) throw Error("native_message_function_ambiguous:" + name);
    const end = source.indexOf("\n}", start);
    if (end < 0 || end - start > (name === "createHostGatewayApi" ? 256 * 1024 : 32_768)) throw Error("native_message_function_layout");
    const selected = source.slice(start + 1, end + 2);
    const sf = ts.createSourceFile("selected.js", selected, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    if (sf.statements.length !== 1 || !ts.isFunctionDeclaration(sf.statements[0]!) || sf.statements[0]!.name?.text !== name) throw Error("native_message_function_shape");
    return digest("function:" + name, selected);
  }
  function owner(name: string) {
    const marker = "\nvar " + name + " = ", start = source.indexOf(marker);
    if (start < 0 || source.indexOf(marker, start + 1) !== -1) throw Error("native_message_owner_ambiguous");
    const end = source.indexOf("\n};", start);
    if (end < 0 || end - start > 512 * 1024) throw Error("native_message_owner_layout");
    const sf = ts.createSourceFile("selected.js", source.slice(start + 1, end + 3), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const statement = sf.statements[0];
    if (sf.statements.length !== 1 || !statement || !ts.isVariableStatement(statement)) throw Error("native_message_owner_shape");
    const value = statement.declarationList.declarations[0]?.initializer;
    if (!value || !ts.isClassExpression(value)) throw Error("native_message_owner_class");
    return (method: string) => {
      const matches = value.members.filter(m => ts.isMethodDeclaration(m) && m.name.getText(sf) === method);
      if (matches.length !== 1) throw Error("native_message_method_ambiguous:" + method);
      return digest(name + "." + method, matches[0]!.getText(sf));
    };
  }
  const db = owner("SandAgentDb"), turn = owner("TurnRuntime"), pipeline = owner("SendPipeline");
  const functions = ["createUserMessage", "createSendMessageEntry", "withTimestampMs", "isValidTimestampMs",
    "parseTranscriptEntry", "parseEntryRows", "transcriptEntryOfJson", "isValidTranscriptEntry",
    "withEmailDraftFrom", "withVoiceCallNudgeCounts", "withBoxEnvSecretTargetKeys",
    "readTranscriptTail", "readCloudAgentPeerIds", "stampBoxRequestEntry", "stampUserFormEntry", "agentWakeOf", "nextEntryId",
    "firstUnusedId", "countUserMessages", "countTrailingUserAttachments", "countTrailingAssistantMessages", "countTrailingSendMessages"];
  const peerLimitName = "TRANSCRIPT_CLOUD_AGENT_PEER_IDS_MAX";
  const peerLimitMarker = `\nvar ${peerLimitName} = `, peerStart = source.indexOf(peerLimitMarker);
  const peerEnd = source.indexOf(";\n", peerStart + peerLimitMarker.length);
  if (peerStart < 0 || source.indexOf(peerLimitMarker, peerStart + 1) >= 0 || peerEnd <= peerStart || peerEnd - peerStart > 1024)
    throw Error("native_message_peer_limit_layout");
  const peerLimitCode = source.slice(peerStart + 1, peerEnd + 1);
  const peerAst = ts.createSourceFile("peer-limit.js", peerLimitCode, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const peerDeclaration = peerAst.statements[0];
  if (peerAst.statements.length !== 1 || !peerDeclaration || !ts.isVariableStatement(peerDeclaration)
    || peerDeclaration.declarationList.declarations.length !== 1) throw Error("native_message_peer_limit_shape");
  const peerInitializer = peerDeclaration.declarationList.declarations[0]!.initializer;
  if (!peerInitializer || !ts.isNumericLiteral(peerInitializer) || !Number.isSafeInteger(Number(peerInitializer.text))
    || Number(peerInitializer.text) <= 0) throw Error("native_message_peer_limit_shape");
  digest("constant:" + peerLimitName, peerLimitCode);
  const prepare = ts.createSourceFile("prepare.js", fn("prepareStatements"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const statements: string[] = [];
  const wanted = new Set(["listTranscriptEntries", "listTranscriptTail", "getTranscriptEntry", "insertTranscriptEntry", "updateTranscriptEntry"]);
  function collect(node: ts.Node): void {
    if (ts.isPropertyAssignment(node) && wanted.has(node.name.getText(prepare))) {
      if (!ts.isCallExpression(node.initializer) || node.initializer.arguments.length !== 1 || !ts.isStringLiteralLike(node.initializer.arguments[0]!)) throw Error("native_message_sql_not_literal");
      statements.push(node.getText(prepare));
    }
    ts.forEachChild(node, collect);
  }
  collect(prepare);
  if (statements.length !== wanted.size) throw Error("native_message_sql_shape");
  digest("sql", statements.join(","));
  const apiSource = fn("createHostGatewayApi");
  const apiFile = ts.createSourceFile("api.js", apiSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const apiMethods: string[] = [];
  function apiVisit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "api"
      && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
      for (const property of node.initializer.properties) {
        if ((ts.isPropertyAssignment(property) || ts.isMethodDeclaration(property))
          && ["sendPrompt", "getAgentTranscriptTail", "getHostStatus"].includes(property.name.getText(apiFile))) {
          apiMethods.push(digest("api:" + property.name.getText(apiFile), property.getText(apiFile)));
        }
      }
    }
    ts.forEachChild(node, apiVisit);
  }
  apiVisit(apiFile);
  if (apiMethods.length !== 3) throw Error("native_message_rpc_shape");
  const session = owner("SessionRuntime");
  const globals = { Date, Number, JSON, Map, Set, performance,
    BOOT_TURN: "boot",
    publishTranscriptMutation() {},
    updateEntry() {},
    getTranscript: (entries: unknown) => entries,
    entryRaisesUnreadSignal: () => false,
    ...overrides,
  };
  const native: unknown = runInNewContext(
    peerLimitCode + "\n" + functions.map(fn).join("\n") + "\n({" +
    "createUserMessage, createSendMessageEntry, readCloudAgentPeerIds, peerIdsLimit: TRANSCRIPT_CLOUD_AGENT_PEER_IDS_MAX," +
    "prepare: (db) => ({" + statements.join(",") + "})," +
    "database: {" + ["appendTranscriptEntry", "appendTranscriptEntries", "updateTranscriptEntry", "getEntryById", "getTranscriptEntries", "getTranscriptTail"].map(db).join(",") + "}," +
    "turn: {" + ["associateTurnUserMessages", "handleAgentUpdate"].map(turn).join(",") + "}," +
    "pipeline: {" + pipeline("appendSendMessageEntry") + "}," +
    "session: {" + session("getAgentTranscriptTail") + "}," +
    "gateway: (manager, deps) => ({" + apiMethods.join(",") + "})" +
    "})", globals, { timeout: 2000, contextCodeGeneration: { strings: false, wasm: false } });
  if (!record(native) || !record(native.database) || !record(native.turn) || !record(native.pipeline)) throw Error("native_message_api_shape");
  return { ...native, dependencyHashes: Object.freeze(hashes), sourceSha: CONT_NATIVE_PAIR.host };
}
