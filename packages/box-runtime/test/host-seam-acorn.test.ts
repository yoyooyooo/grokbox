import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import {
  ACORN_SHAPE_ENGINE,
  ACORN_VERSION,
  acornShapeSync,
  compareShapeEngines,
  runAcornShape,
} from "../src/internal/ops/host-seam/shape-acorn.ts";
import { structuralShapeSync } from "../src/internal/ops/host-seam/shape.ts";
import {
  utf16RangeToUtf8,
  utf8RangeToUtf16,
  verifyUtf16Utf8RoundTrip,
} from "../src/internal/ops/host-seam/utf16-utf8.ts";
import { LIVE_SHAPED_HOST } from "./live-shaped-host.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("HSO-4 Acorn structural worker", () => {
  test("UTF-16 code units are not UTF-8 bytes; round-trip keeps original substring", () => {
    const source = "/* 中文😀 */createSession";
    const start = source.indexOf("createSession");
    const end = source.length;
    expect(start).toBeGreaterThan(0);
    expect(verifyUtf16Utf8RoundTrip(source, start, end)).toBe(true);
    const utf8 = utf16RangeToUtf8(source, start, end)!;
    expect(utf8.startByte).not.toBe(start);
    expect(utf8.startByte).toBe(Buffer.byteLength(source.slice(0, start), "utf8"));
    expect(utf8RangeToUtf16(source, utf8.startByte, utf8.endByte)).toEqual({ start, end });
    expect(Buffer.from(source, "utf8").subarray(utf8.startByte, utf8.endByte).toString("utf8")).toBe("createSession");
  });

  test("locked Acorn locates create-session and agent-id on UTF-8 windows", () => {
    const prefix = "/* 中文😀 sentinel */\n";
    const source = prefix + LIVE_SHAPED_HOST;
    const report = acornShapeSync(source);
    expect(report.status).toBe("ok");
    expect(report.engine).toBe(ACORN_SHAPE_ENGINE);
    expect(report.engine).toContain(ACORN_VERSION);
    const create = report.candidates.filter((row) => row.sliceId === "create-session");
    const agent = report.candidates.filter((row) => row.sliceId === "agent-id");
    expect(create).toHaveLength(1);
    expect(agent).toHaveLength(1);
    expect(create[0]!.params).toEqual(["onRequestId", "sessionOptions"]);
    expect(agent[0]!.binding).toMatchObject({ optionsName: "mainSessionOptions", hostName: "host", modelField: "subagentModelId" });
    expect(create[0]!.startByte).toBeGreaterThanOrEqual(Buffer.byteLength(prefix, "utf8"));
    expect(create[0]!.startByte).not.toBe(prefix.length);
    const bytes = Buffer.from(source, "utf8");
    expect(sha256Text(bytes.subarray(create[0]!.startByte, create[0]!.endByte).toString("utf8"))).toBe(create[0]!.windowSha256);
  });

  test("minify, CRLF, Unicode comments, param rename, sibling reorder still locate", () => {
    const renamed = LIVE_SHAPED_HOST
      .replaceAll("onRequestId", "cb")
      .replaceAll("sessionOptions", "opts");
    const crlf = renamed.replaceAll("\n", "\r\n");
    const unicode = `/* 中文哨兵 */\n${crlf}`;
    const reordered = unicode.replace(
      "recordPostTurnLabeling(args) {\n      return args;\n    },",
      "otherSibling() { return 1; },\n    recordPostTurnLabeling(args) {\n      return args;\n    },",
    );
    const min = reordered.replace(/\/\/[^\n]*/g, "").replace(/\s+/g, " ");
    for (const source of [renamed, crlf, unicode, reordered, min]) {
      const report = acornShapeSync(source);
      expect(report.status).toBe("ok");
      const create = report.candidates.find((row) => row.sliceId === "create-session");
      expect(create?.params?.[0]).toBe("cb");
      expect(create?.params?.[1]).toBe("opts");
      expect(report.candidates.some((row) => row.sliceId === "agent-id")).toBe(true);
    }
  });

  test("two-arg decoy and string/regex fakes stay ambiguous or unused", () => {
    const decoy = LIVE_SHAPED_HOST.replace(
      "const api = {",
      `const decoy = {
  createSession(onRequestId, sessionOptions) {
    return createCursorInferencePromptSession(sessionOptions);
  },
  recordPostTurnLabeling(args) { return args; },
};
const api = {`,
    );
    const decoyReport = acornShapeSync(decoy);
    const creates = decoyReport.candidates.filter((row) => row.sliceId === "create-session");
    expect(creates.length).toBeGreaterThan(1);
    expect(creates.every((row) => row.limitations.includes("ambiguous-site"))).toBe(true);

    const stringy = `const decoy = "createSession(onRequestId, sessionOptions) { return createCursorInferencePromptSession(x); }";\n${LIVE_SHAPED_HOST}`;
    expect(acornShapeSync(stringy).candidates.filter((row) => row.sliceId === "create-session")).toHaveLength(1);

    const regex = LIVE_SHAPED_HOST.replace(
      "function runTurn(host) {",
      "const fake = /createSession(onRequestId, sessionOptions)/;\nfunction runTurn(host) {",
    );
    expect(acornShapeSync(regex).candidates.filter((row) => row.sliceId === "create-session")).toHaveLength(1);
  });

  test("Acorn is not a monopoly versus lexical; disagreement is not auto-selected", () => {
    const lexical = structuralShapeSync(LIVE_SHAPED_HOST);
    const acorn = acornShapeSync(LIVE_SHAPED_HOST);
    expect(lexical.status).toBe("ok");
    expect(acorn.status).toBe("ok");
    const compared = compareShapeEngines(lexical, acorn);
    expect(compared.limitations.includes("ast_not_monopoly") || compared.agree).toBe(true);
    expect(acorn.candidates.some((row) => row.sliceId === "create-session")).toBe(true);
    expect(lexical.candidates.some((row) => row.sliceId === "create-session")).toBe(true);
  });

  test("grammar error does not recover; worker timeout is reaped", async () => {
    const bad = acornShapeSync("const x = \"unterminated");
    expect(bad.status).toBe("unavailable");
    expect(bad.reason).toBe("grammar_error");
    expect(bad.limitations).toContain("syntaxUnverified");

    const prev = process.env.GROKBOX_SHAPE_WORKER_STALL;
    process.env.GROKBOX_SHAPE_WORKER_STALL = "1";
    try {
      const hung = await runAcornShape("const x = 1;\n", { timeoutMs: 80 });
      expect(hung.status).toBe("unavailable");
      expect(hung.reason).toBe("timeout");
    } finally {
      if (prev === undefined) delete process.env.GROKBOX_SHAPE_WORKER_STALL;
      else process.env.GROKBOX_SHAPE_WORKER_STALL = prev;
    }
  });

  test("preload, compile-hook, and host hot path do not import Acorn", () => {
    const preload = readFileSync(join(repoRoot, "packages/box-runtime/src/preload.ts"), "utf8");
    const compile = readFileSync(join(repoRoot, "packages/box-runtime/src/internal/host/compile-hook.ts"), "utf8");
    const session = readFileSync(join(repoRoot, "packages/box-runtime/src/internal/host/session-hook.ts"), "utf8");
    for (const src of [preload, compile, session]) {
      expect(src).not.toContain("acorn");
      expect(src).not.toContain("shape-acorn");
      expect(src).not.toContain("host-seam/shape");
    }
  });
});
