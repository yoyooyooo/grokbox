import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

import { nativeContinuityPair } from "./native-continuity-pair.ts";
import { HOST_RECIPE } from "../src/internal/host/source-recipes.ts";
import { transformUnchecked } from "../src/internal/host/profile.ts";
import { NATIVE_CURRENT_STATE_SYMBOL } from "../src/internal/host/native-current-state-owner.ts";
// Independent current expected bytes. Qualification remains an explicit
// isolated codec/AgentStore experiment, never a production qualification write.
export const CONT_NATIVE_PAIR = nativeContinuityPair(process.env);
export const nativeContinuityEnabled = () => process.env.GROKBOX_TEST_NATIVE_CONTINUITY === "1";
const checked = (path: string, hash: string) => {
  const source = readFileSync(path, "utf8");
  if (createHash("sha256").update(source).digest("hex") !== hash) throw Error("native_continuity_source_mismatch");
  return source;
};

/** Lexical dependencies of selected original declarations only. Never import
 * the worker/Host entrypoint, execute top-level statements or expose IO.
 * Private implementation stays in the installed file and ephemeral VM memory. */
function pureDeclarations(source: string, names: string[]) {
  const filename = "qualified-worker.js";
  const options: ts.CompilerOptions = { allowJs: true, noLib: true, target: ts.ScriptTarget.ESNext };
  const sf = ts.createSourceFile(filename, source, options.target!, true, ts.ScriptKind.JS);
  const host: ts.CompilerHost = { getSourceFile: name => name === filename ? sf : undefined, getDefaultLibFileName: () => "",
    writeFile: () => { throw Error("native_source_write_forbidden"); }, getCurrentDirectory: () => "", getDirectories: () => [],
    fileExists: name => name === filename, readFile: name => name === filename ? source : undefined,
    getCanonicalFileName: name => name, useCaseSensitiveFileNames: () => true, getNewLine: () => "\n" };
  const checker = ts.createProgram([filename], options, host).getTypeChecker();
  const declarations = new Map<string, ts.Node>();
  for (const statement of sf.statements) {
    if (ts.isVariableStatement(statement)) for (const d of statement.declarationList.declarations) {
      if (ts.isIdentifier(d.name)) declarations.set(d.name.text, d);
    }
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) declarations.set(statement.name.text, statement);
  }
  const selected = new Set<ts.Node>();
  function select(node: ts.Node) {
    if (selected.has(node)) return;
    selected.add(node);
    // Generated TypeScript numeric enums use a declaration plus a finite IIFE.
    // Admit only literal assignment bodies immediately following that declaration.
    if (ts.isVariableDeclaration(node) && !node.initializer) {
      const statement = node.parent.parent;
      const next = sf.statements[sf.statements.indexOf(statement as ts.Statement) + 1];
      if (next && ts.isExpressionStatement(next) && ts.isCallExpression(next.expression)) {
        let fn: ts.Expression = next.expression.expression;
        while (ts.isParenthesizedExpression(fn)) fn = fn.expression;
        if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isBlock(fn.body) && fn.parameters.length === 1
          && fn.body.statements.every(s => ts.isExpressionStatement(s) && ts.isBinaryExpression(s.expression)
            && s.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isStringLiteral(s.expression.right))) select(next);
      }
    }
    function visit(child: ts.Node): void {
      if (ts.isCallExpression(child) && ts.isIdentifier(child.expression) && ["require", "eval", "Function"].includes(child.expression.text)) throw Error("native_pure_dependency_has_external_power");
      if (ts.isIdentifier(child)) for (const d of (ts.isShorthandPropertyAssignment(child.parent)
        ? checker.getShorthandAssignmentValueSymbol(child.parent) : checker.getSymbolAtLocation(child))?.declarations ?? []) {
        if (d.getSourceFile() !== sf) continue;
        const name = (ts.isVariableDeclaration(d) || ts.isFunctionDeclaration(d) || ts.isClassDeclaration(d)) && d.name;
        if (name && ts.isIdentifier(name) && declarations.get(name.text) === d) select(d);
      }
      ts.forEachChild(child, visit);
    }
    ts.forEachChild(node, visit);
  }
  for (const name of names) { const node = declarations.get(name); if (!node) throw Error(`native_pure_declaration_missing:${name}`); select(node); }
  return [...selected].sort((a, b) => a.pos - b.pos).map(node => ts.isVariableDeclaration(node) ? `var ${node.getText(sf)};` : node.getText(sf)).join("\n");
}
/** Select a single declaration in the exact pinned bundle's emitted layout.
 * Parse only that declaration and reject ambiguous/layout-changed selections.
 * Building an AST of the entire 600k+ line Host in every Node child is unrelated
 * to these checks and creates substantial memory pressure on the shared Box. */
function hostDeclaration(source: string, name: string) {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) throw Error("native_declaration_name_invalid");
  const marker = `\nvar ${name} = `;
  const at = source.indexOf(marker);
  if (at < 0 || source.indexOf(marker, at + marker.length) >= 0) throw Error(`native_declaration_missing_or_ambiguous:${name}`);
  const end = source.indexOf("\n};", at + marker.length);
  if (end < 0 || end - at > 512 * 1024) throw Error("native_declaration_layout_changed");
  const selected = source.slice(at + 1, end + 3);
  const parsed = ts.createSourceFile("selected-qualified-host.js", selected, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const statement = parsed.statements[0];
  if (parsed.statements.length !== 1 || !statement || !ts.isVariableStatement(statement)
    || statement.declarationList.declarations.length !== 1) throw Error("native_declaration_layout_changed");
  const declaration = statement.declarationList.declarations[0]!;
  if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) throw Error("native_declaration_layout_changed");
  return { parsed, declaration, code: selected };
}

let cached: any;
export function nativeContinuityCode(): any {
  if (!nativeContinuityEnabled()) throw Error("native_continuity_not_opted_in");
  const root = "/home/box/sand-host";
  const worker = checked(`${root}/agent-isolation/agent-store-worker.cjs`, CONT_NATIVE_PAIR.worker);
  const source = checked(`${root}/host-main.cjs`, CONT_NATIVE_PAIR.host);
  // A cached declaration cannot extend qualification to replaced disk bytes.
  if (cached) return cached;
  const names = ["ConversationStateStructure", "ConversationSummaryArchive", "UserMessage", "ConversationTurnStructure", "AgentConversationTurnStructure",
    "BLOB_REFERENCE_MESSAGE_TYPE_BY_NAME", "getBlobReferenceMessageMetadata", "isMessage", "collectReachableBlobHexIds"];
  const globals = { Uint8Array, Uint32Array, Int32Array, Int8Array, Uint16Array, Int16Array, Float32Array, Float64Array, BigInt64Array,
    BigUint64Array, ArrayBuffer, DataView, TextEncoder, TextDecoder, Buffer, Map, Set, WeakMap, WeakSet, BigInt,
    process: Object.freeze({ env: Object.freeze({}) }), console: Object.freeze({ warn: () => undefined }) };
  const codecCode = pureDeclarations(worker, names);
  const native = runInNewContext(`${codecCode}\n({${names.join(",")}})`, globals,
    { timeout: 5000, contextCodeGeneration: { strings: false, wasm: false } });
  // The worker codec used below must describe the same original Host messages.
  // Source-pair pin alone is not permission to substitute a different protocol.
  const wanted = new Map<string, string>(Object.values(native.BLOB_REFERENCE_MESSAGE_TYPE_BY_NAME).map((type: any) => [type.name, type.$()[0]]));
  const found = new Set<string>(), present = new Set<string>();
  // These four reference decoders are worker-only in this exact pair: the main
  // bundle has no such class. They are qualified by the worker pin, not a made-up
  // equality check against nonexistent main declarations. Any present mismatch
  // (or any other missing shared class) still fails.
  const workerOnly = new Set(["_RequestContextMcpsPart", "_RequestContextRulesPart", "_RequestContextSkillsPart", "_RequestContextSubagentsPart"]);
  for (const [name, signature] of wanted) {
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) throw Error("native_class_name_invalid");
    const escaped = name.replace(/[$]/g, "\\$");
    const matches = [...source.matchAll(new RegExp(`^([ ]*)(?:var )?([A-Za-z_$][A-Za-z0-9_$]*) = class ${escaped}[ {]`, "gm"))];
    if (matches.length > 8) throw Error("native_schema_candidate_limit");
    if (!matches.length) continue;
    present.add(name);
    // Different protobuf namespaces can reuse a JS class name (e.g. TodoItem).
    // As in the full-AST check, select by exact schema descriptor, not by alias
    // order or a generated numeric suffix. Never execute a lazy init function.
    for (const match of matches) {
      const start = match.index! + match[0].indexOf("class ");
      const end = source.indexOf(`\n${match[1]}};`, start);
      if (end < 0 || end - start > 512 * 1024) throw Error("native_schema_layout_changed");
      const code = `var __selected = ${source.slice(start, end + 2 + match[1]!.length)};`;
      const parsed = ts.createSourceFile("selected-qualified-schema.js", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      const statement = parsed.statements[0];
      if (parsed.statements.length !== 1 || !statement || !ts.isVariableStatement(statement)
        || statement.declarationList.declarations.length !== 1) throw Error("native_schema_layout_changed");
      const node = statement.declarationList.declarations[0]!.initializer;
      if (!node || !ts.isClassExpression(node) || node.name?.text !== name) throw Error("native_schema_layout_changed");
      const descriptor = node.members.find(m => ts.isMethodDeclaration(m) && m.name.getText(parsed) === "$");
      if (descriptor && ts.isMethodDeclaration(descriptor)) {
        const result = descriptor.body?.statements.find(ts.isReturnStatement)?.expression;
        const first = result && ts.isArrayLiteralExpression(result) ? result.elements[0] : undefined;
        if (first && ts.isStringLiteral(first) && first.text === signature) found.add(name);
      }
    }
  }
  const mismatches = [...wanted.keys()].filter(name => !found.has(name) && (!workerOnly.has(name) || present.has(name)));
  if (mismatches.length) throw Error(`native_host_worker_schema_disagreement:${mismatches.join(",")}`);
  const pick = (name: string) => hostDeclaration(source, name).code;
  const awaiterCode = pick("__awaiter45"), serdeCode = pick("ProtoSerde"), writerCode = pick("AgentStore2");
  const checkpointSlices = HOST_RECIPE.currentState.filter(slice =>
    ["continuity-native-checkpoint-fence", "continuity-native-checkpoint-revision"].includes(slice.id));
  if (checkpointSlices.length !== 2) throw Error("native_checkpoint_recipe_incomplete");
  const patched = transformUnchecked(source, checkpointSlices);
  if (!patched.ok) throw Error(`native_checkpoint_recipe_mismatch:${patched.sliceId}`);
  const patchedWriterCode = hostDeclaration(patched.source, "AgentStore2").code;
  const writer = (code: string, control?: unknown) => runInNewContext(`${awaiterCode}\n${serdeCode}\n${code}\nAgentStore2`, {
    ...globals, ConversationStateStructure: native.ConversationStateStructure,
    [Symbol.for(NATIVE_CURRENT_STATE_SYMBOL)]: control,
    Disposable: class {}, getBlobId: async (bytes: Uint8Array) => createHash("sha256").update(bytes).digest(),
  }, { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } });
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  cached = { ...native, AgentStore: writer(writerCode),
    currentAgentStore: (control?: unknown) => writer(patchedWriterCode, control),
    dependencyHashes: Object.freeze({ codecDeclarations: digest(codecCode),
      sharedDescriptors: digest(JSON.stringify([...wanted].sort(([a], [b]) => a.localeCompare(b)))),
      awaiter: digest(awaiterCode), serde: digest(serdeCode), agentStore: digest(writerCode),
      patchedAgentStore: digest(patchedWriterCode) }) };
  return cached;
}
