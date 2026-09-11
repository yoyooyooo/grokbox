#!/usr/bin/env bun
/**
 * Owned HSO-4 Acorn structural worker. Strict CJS parse only — not acorn-loose,
 * not imported by preload. Parent must reap this process.
 */
import * as acorn from "acorn";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import { utf16RangeToUtf8, verifyUtf16Utf8RoundTrip } from "./utf16-utf8.ts";
import type { ShapeCandidate, ShapeReport } from "./shape-worker.ts";

export const ACORN_VERSION = "8.14.1";
export const ACORN_ECMA = 2022 as const;
export const ACORN_SHAPE_ENGINE = `acorn-${ACORN_VERSION}` as const;
const MAX_SOURCE = 8 * 1024 * 1024;
const MAX_CANDIDATES = 16;

type AstNode = {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
};

function asNode(value: unknown): AstNode | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.type !== "string" || typeof row.start !== "number" || typeof row.end !== "number") return undefined;
  return row as AstNode;
}

function walk(node: AstNode, visit: (n: AstNode, parent: AstNode | undefined) => void, parent?: AstNode): void {
  visit(node, parent);
  for (const [key, child] of Object.entries(node)) {
    if (key === "start" || key === "end" || key === "loc" || key === "range") continue;
    if (Array.isArray(child)) {
      for (const item of child) {
        const next = asNode(item);
        if (next) walk(next, visit, node);
      }
    } else {
      const next = asNode(child);
      if (next) walk(next, visit, node);
    }
  }
}

function identifierName(node: unknown): string | undefined {
  const n = asNode(node);
  return n?.type === "Identifier" && typeof n.name === "string" ? n.name : undefined;
}

function containsCall(root: AstNode, name: string): boolean {
  let found = false;
  walk(root, (node) => {
    if (found) return;
    if (node.type === "CallExpression" && identifierName(node.callee) === name) found = true;
  });
  return found;
}

function objectHasSpread(obj: AstNode): boolean {
  const props = Array.isArray(obj.properties) ? obj.properties : [];
  return props.some((prop) => asNode(prop)?.type === "SpreadElement");
}

function rangeOf(source: string, start: number, end: number): { startByte: number; endByte: number; windowSha256: string } | undefined {
  if (!verifyUtf16Utf8RoundTrip(source, start, end)) return undefined;
  const utf8 = utf16RangeToUtf8(source, start, end);
  if (!utf8) return undefined;
  return { ...utf8, windowSha256: sha256Text(source.slice(start, end)) };
}

function sessionMethods(ast: AstNode, source: string): ShapeCandidate[] {
  const rows: ShapeCandidate[] = [];
  walk(ast, (node) => {
    if (node.type !== "Property") return;
    const value = asNode(node.value);
    if (!value || value.type !== "FunctionExpression") return;
    const params = Array.isArray(value.params) ? value.params : [];
    if (params.length !== 2) return;
    const p0 = identifierName(params[0]);
    const p1 = identifierName(params[1]);
    if (!p0 || !p1) return;
    const body = asNode(value.body);
    if (!body || !containsCall(body, "createCursorInferencePromptSession")) return;
    const keyStart = typeof node.start === "number" ? node.start : value.start;
    const mapped = rangeOf(source, keyStart, value.end);
    if (!mapped) return;
    const name = identifierName(node.key) ?? "";
    const limitations = ["acorn_binding_only"];
    if (name !== "createSession") limitations.push("name_is_evidence_not_identity");
    rows.push({
      sliceId: "create-session",
      ...mapped,
      params: [p0, p1],
      limitations,
    });
  });
  if (rows.length > 1) {
    for (const row of rows) row.limitations.push("ambiguous-site");
  }
  return rows;
}

function agentBinds(ast: AstNode, source: string): ShapeCandidate[] {
  const binds: Array<{ name: string; host: string; field: string; objStart: number; objEnd: number; spread: boolean }> = [];
  walk(ast, (node) => {
    if (node.type !== "VariableDeclarator") return;
    const name = identifierName(node.id);
    const init = asNode(node.init);
    if (!name || !init || init.type !== "ObjectExpression") return;
    const props = Array.isArray(init.properties) ? init.properties : [];
    let host: string | undefined;
    let field: string | undefined;
    for (const raw of props) {
      const prop = asNode(raw);
      if (!prop || prop.type !== "Property") continue;
      if (identifierName(prop.key) !== "modelId") continue;
      const value = asNode(prop.value);
      if (!value || value.type !== "MemberExpression") continue;
      host = identifierName(value.object);
      field = identifierName(value.property);
    }
    if (!host || !field) return;
    binds.push({
      name,
      host,
      field,
      objStart: init.start,
      objEnd: init.end,
      spread: objectHasSpread(init),
    });
  });

  const used = new Set<string>();
  walk(ast, (node) => {
    if (node.type !== "CallExpression") return;
    const callee = asNode(node.callee);
    if (!callee || callee.type !== "MemberExpression") return;
    if (identifierName(callee.property) !== "createSession") return;
    const args = Array.isArray(node.arguments) ? node.arguments : [];
    const options = identifierName(args[1]);
    if (options) used.add(options);
  });

  const rows: ShapeCandidate[] = [];
  for (const bind of binds) {
    if (!used.has(bind.name)) continue;
    const mapped = rangeOf(source, bind.objStart, bind.objEnd);
    if (!mapped) continue;
    const limitations = ["acorn_binding_only"];
    if (bind.spread) limitations.push("spread_unverified");
    rows.push({
      sliceId: "agent-id",
      ...mapped,
      binding: { optionsName: bind.name, hostName: bind.host, modelField: bind.field },
      limitations,
    });
  }
  if (rows.length > 1) {
    for (const row of rows) row.limitations.push("ambiguous-site");
  }
  return rows;
}

export function acornShapeFromSource(source: string, maxCandidates = MAX_CANDIDATES): ShapeReport {
  const utf8Bytes = Buffer.byteLength(source, "utf8");
  const engine = ACORN_SHAPE_ENGINE;
  if (acorn.version !== ACORN_VERSION) {
    return {
      status: "unavailable",
      reason: "grammar_error",
      engine,
      utf8Bytes,
      candidates: [],
      truncated: false,
      limitations: ["parser_version_drift", `acorn_${acorn.version}`],
    };
  }
  if (utf8Bytes > MAX_SOURCE) {
    return {
      status: "unavailable",
      reason: "source_too_large",
      engine,
      utf8Bytes,
      candidates: [],
      truncated: false,
      limitations: ["source_too_large"],
    };
  }
  let ast: AstNode;
  try {
    ast = acorn.parse(source, {
      ecmaVersion: ACORN_ECMA,
      sourceType: "script",
      ranges: true,
      allowReturnOutsideFunction: true,
      allowHashBang: true,
    }) as unknown as AstNode;
  } catch {
    return {
      status: "unavailable",
      reason: "grammar_error",
      engine,
      utf8Bytes,
      candidates: [],
      truncated: false,
      limitations: ["syntaxUnverified"],
    };
  }
  const session = sessionMethods(ast, source);
  const agents = agentBinds(ast, source);
  const merged = [...session, ...agents];
  if (merged.length > maxCandidates) {
    return {
      status: "unavailable",
      reason: "candidate_explosion",
      engine,
      utf8Bytes,
      candidates: merged.slice(0, maxCandidates),
      truncated: true,
      limitations: ["candidate_explosion"],
    };
  }
  return {
    status: "ok",
    engine,
    utf8Bytes,
    candidates: merged,
    truncated: false,
    limitations: merged.length === 0 ? ["no_structural_candidate"] : [`parser:${engine}`, `ecmaVersion:${ACORN_ECMA}`, "sourceType:script"],
  };
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

if (import.meta.main) {
  if (process.env.GROKBOX_SHAPE_WORKER_STALL === "1") {
    await new Promise(() => undefined);
  }
  const raw = await readStdin();
  let parsed: { source?: string; maxCandidates?: number };
  try {
    parsed = JSON.parse(raw) as { source?: string; maxCandidates?: number };
  } catch {
    process.stdout.write(`${JSON.stringify({
      status: "unavailable",
      reason: "grammar_error",
      engine: ACORN_SHAPE_ENGINE,
      utf8Bytes: 0,
      candidates: [],
      truncated: false,
      limitations: ["invalid_request"],
    })}\n`);
    process.exit(0);
  }
  const report = acornShapeFromSource(typeof parsed.source === "string" ? parsed.source : "", parsed.maxCandidates ?? MAX_CANDIDATES);
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
