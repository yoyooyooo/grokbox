#!/usr/bin/env bun
/**
 * Owned HSO-4 structural worker. Lexical CJS only — not a recovering parser,
 * not imported by preload. Parent must reap this process.
 */
import { sha256Text } from "@grokbox/runtime-kernel/hash";

export const SHAPE_ENGINE = "lexical-cjs-v1";
const MAX_SOURCE = 8 * 1024 * 1024;
const MAX_CANDIDATES = 16;

type Tok = { k: "id" | "punc" | "eof"; v: string; a: number; b: number };

export type ShapeCandidate = {
  sliceId: "create-session" | "agent-id";
  startByte: number;
  endByte: number;
  windowSha256: string;
  params?: [string, string];
  binding?: { optionsName: string; hostName: string; modelField: string; turnName?: string };
  limitations: string[];
};

export type ShapeReport = {
  status: "ok" | "unavailable";
  reason?: "grammar_error" | "timeout" | "oom" | "candidate_explosion" | "source_too_large";
  engine: typeof SHAPE_ENGINE;
  utf8Bytes: number;
  candidates: ShapeCandidate[];
  truncated: boolean;
  limitations: string[];
};

function grammar(): never {
  throw Object.assign(new Error("grammar_error"), { code: "grammar_error" });
}

function isIdStart(c: string): boolean {
  return /[A-Za-z_$\u0080-\uFFFF]/.test(c);
}

function isIdPart(c: string): boolean {
  return isIdStart(c) || /[0-9]/.test(c);
}

function regexStart(prev: Tok | undefined): boolean {
  if (!prev || prev.k === "eof") return true;
  if (prev.k !== "punc") return false;
  return "([{,;:=!&|?+-~*%^<>".includes(prev.v[0]!);
}

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const n = src.length;
  const push = (k: Tok["k"], v: string, a: number, b: number) => {
    out.push({ k, v, a, b });
  };
  while (i < n) {
    const c = src[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i += 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      i = nl < 0 ? n : nl;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end < 0) grammar();
      i = end + 2;
      continue;
    }
    if (c === "'" || c === "\"") {
      const q = c;
      i += 1;
      let closed = false;
      while (i < n) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === q) {
          i += 1;
          closed = true;
          break;
        }
        if (src[i] === "\n") grammar();
        i += 1;
      }
      if (!closed) grammar();
      continue;
    }
    if (c === "`") {
      i += 1;
      let depth = 0;
      while (i < n) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === "`" && depth === 0) {
          i += 1;
          break;
        }
        if (src[i] === "$" && src[i + 1] === "{") {
          depth += 1;
          i += 2;
          continue;
        }
        if (src[i] === "}" && depth > 0) {
          depth -= 1;
          i += 1;
          continue;
        }
        i += 1;
      }
      continue;
    }
    if (c === "/" && regexStart(out.at(-1))) {
      i += 1;
      while (i < n) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === "/") {
          i += 1;
          while (i < n && /[a-z]/i.test(src[i]!)) i += 1;
          break;
        }
        if (src[i] === "\n") grammar();
        i += 1;
      }
      continue;
    }
    if (isIdStart(c)) {
      const a = i;
      i += 1;
      while (i < n && isIdPart(src[i]!)) i += 1;
      push("id", src.slice(a, i), a, i);
      continue;
    }
    if (c >= "0" && c <= "9") {
      const a = i;
      i += 1;
      while (i < n && /[0-9.xXa-fA-F]/.test(src[i]!)) i += 1;
      continue;
    }
    push("punc", c, i, i + 1);
    i += 1;
  }
  push("eof", "", n, n);
  return out;
}

function utf8Range(src: string, a: number, b: number): { startByte: number; endByte: number; windowSha256: string } {
  const startByte = Buffer.byteLength(src.slice(0, a), "utf8");
  const endByte = startByte + Buffer.byteLength(src.slice(a, b), "utf8");
  return { startByte, endByte, windowSha256: sha256Text(src.slice(a, b)) };
}

function matchBrace(src: string, open: number): number {
  let depth = 0;
  let i = open;
  const n = src.length;
  let mode: "code" | "line" | "block" | "s" | "d" | "t" = "code";
  while (i < n) {
    const c = src[i]!;
    if (mode === "line") {
      if (c === "\n") mode = "code";
      i += 1;
      continue;
    }
    if (mode === "block") {
      if (c === "*" && src[i + 1] === "/") {
        mode = "code";
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (mode === "s" || mode === "d") {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if ((mode === "s" && c === "'") || (mode === "d" && c === "\"")) mode = "code";
      i += 1;
      continue;
    }
    if (mode === "t") {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "`") mode = "code";
      i += 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      mode = "line";
      i += 2;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      mode = "block";
      i += 2;
      continue;
    }
    if (c === "'") {
      mode = "s";
      i += 1;
      continue;
    }
    if (c === "\"") {
      mode = "d";
      i += 1;
      continue;
    }
    if (c === "`") {
      mode = "t";
      i += 1;
      continue;
    }
    if (c === "{") depth += 1;
    if (c === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  grammar();
}

function twoParamMethods(src: string, toks: Tok[]): Array<{ name: string; p0: string; p1: string; sigA: number; bodyA: number; bodyB: number; prev: string }> {
  const rows = [];
  for (let i = 0; i < toks.length - 8; i += 1) {
    const name = toks[i]!;
    if (name.k !== "id") continue;
    if (toks[i + 1]?.v !== "(") continue;
    const p0 = toks[i + 2];
    if (p0?.k !== "id") continue;
    if (toks[i + 3]?.v !== ",") continue;
    const p1 = toks[i + 4];
    if (p1?.k !== "id") continue;
    if (toks[i + 5]?.v !== ")") continue;
    if (toks[i + 6]?.v !== "{") continue;
    const prev = toks[i - 1];
    if (prev?.v === "async" || prev?.v === "function" || prev?.v === "*") continue;
    if (prev && prev.k === "id") continue;
    const bodyA = toks[i + 6]!.a;
    const bodyB = matchBrace(src, bodyA);
    rows.push({
      name: name.v,
      p0: p0.v,
      p1: p1.v,
      sigA: name.a,
      bodyA,
      bodyB: bodyB + 1,
      prev: prev?.v ?? "",
    });
  }
  return rows;
}

function analyze(source: string, maxCandidates: number): ShapeReport {
  const utf8Bytes = Buffer.byteLength(source, "utf8");
  if (utf8Bytes > MAX_SOURCE) {
    return { status: "unavailable", reason: "source_too_large", engine: SHAPE_ENGINE, utf8Bytes, candidates: [], truncated: false, limitations: ["source_too_large"] };
  }
  const toks = tokenize(source);
  const methods = twoParamMethods(source, toks);
  const candidates: ShapeCandidate[] = [];
  let truncated = false;
  const sessionMethods = methods.filter((row) => {
    const body = source.slice(row.bodyA, row.bodyB);
    const factory = /createCursorInferencePromptSession\s*\(/.test(body);
    const inString = row.prev === "\"" || row.prev === "'" || row.prev === "`";
    return factory && !inString;
  });
  for (const row of sessionMethods) {
    if (candidates.length >= maxCandidates) {
      truncated = true;
      break;
    }
    const range = utf8Range(source, row.sigA, row.bodyB);
    const limitations: string[] = ["lexical_binding_only"];
    if (sessionMethods.length > 1) limitations.push("ambiguous-site");
    if (row.name !== "createSession") limitations.push("name_is_evidence_not_identity");
    candidates.push({
      sliceId: "create-session",
      ...range,
      params: [row.p0, row.p1],
      limitations,
    });
  }

  const objectBinds: Array<{ name: string; host: string; field: string; objA: number; objB: number }> = [];
  for (let i = 0; i < toks.length - 10; i += 1) {
    if (toks[i]?.k !== "id" || !["const", "let", "var"].includes(toks[i]!.v)) continue;
    const name = toks[i + 1];
    if (name?.k !== "id") continue;
    if (toks[i + 2]?.v !== "=") continue;
    if (toks[i + 3]?.v !== "{") continue;
    const objA = toks[i + 3]!.a;
    const objB = matchBrace(source, objA) + 1;
    const inner = source.slice(objA, objB);
    const model = inner.match(/modelId\s*:\s*([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)/);
    if (!model) continue;
    objectBinds.push({ name: name.v, host: model[1]!, field: model[2]!, objA, objB });
  }

  const agentRows: ShapeCandidate[] = [];
  for (const bind of objectBinds) {
    const call = new RegExp(`\\.createSession\\s*\\(\\s*([A-Za-z_$][\\w$]*)\\s*,\\s*${bind.name}\\s*\\)`);
    const matched = call.exec(source);
    if (!matched) continue;
    if (agentRows.length + candidates.length >= maxCandidates) {
      truncated = true;
      break;
    }
    const range = utf8Range(source, bind.objA, bind.objB);
    const limitations: string[] = ["lexical_binding_only"];
    if (objectBinds.length > 1) limitations.push("ambiguous-site");
    agentRows.push({
      sliceId: "agent-id",
      ...range,
      binding: { optionsName: bind.name, hostName: bind.host, modelField: bind.field },
      limitations,
    });
  }
  candidates.push(...agentRows);

  if (truncated && candidates.length >= maxCandidates) {
    return {
      status: "unavailable",
      reason: "candidate_explosion",
      engine: SHAPE_ENGINE,
      utf8Bytes,
      candidates,
      truncated: true,
      limitations: ["candidate_explosion"],
    };
  }
  return {
    status: "ok",
    engine: SHAPE_ENGINE,
    utf8Bytes,
    candidates,
    truncated,
    limitations: candidates.length === 0 ? ["no_structural_candidate"] : [],
  };
}

export function shapeFromSource(source: string, maxCandidates = MAX_CANDIDATES): ShapeReport {
  try {
    return analyze(source, maxCandidates);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
    return {
      status: "unavailable",
      reason: code === "grammar_error" ? "grammar_error" : "grammar_error",
      engine: SHAPE_ENGINE,
      utf8Bytes: Buffer.byteLength(source, "utf8"),
      candidates: [],
      truncated: false,
      limitations: ["syntaxUnverified"],
    };
  }
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
      engine: SHAPE_ENGINE,
      utf8Bytes: 0,
      candidates: [],
      truncated: false,
      limitations: ["invalid_request"],
    })}\n`);
    process.exit(0);
  }
  const report = shapeFromSource(typeof parsed.source === "string" ? parsed.source : "", parsed.maxCandidates ?? MAX_CANDIDATES);
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
