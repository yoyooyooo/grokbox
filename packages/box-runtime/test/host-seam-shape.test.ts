import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import { runStructuralShape, structuralShapeSync } from "../src/internal/ops/host-seam/shape.ts";
import { LIVE_SHAPED_HOST } from "./live-shaped-host.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

function minifyOutsideStrings(source: string): string {
  return source.replace(/\/\/[^\n]*/g, "").replace(/\s+/g, " ");
}

describe("HSO-4 structural shape worker", () => {
  test("LIVE_SHAPED_HOST locates create-session and agent-id with UTF-8 ranges", () => {
    const report = structuralShapeSync(LIVE_SHAPED_HOST);
    expect(report.status).toBe("ok");
    expect(report.engine).toBe("lexical-cjs-v1");
    const create = report.candidates.filter((row) => row.sliceId === "create-session");
    const agent = report.candidates.filter((row) => row.sliceId === "agent-id");
    expect(create).toHaveLength(1);
    expect(agent).toHaveLength(1);
    expect(create[0]!.params).toEqual(["onRequestId", "sessionOptions"]);
    expect(agent[0]!.binding).toMatchObject({ optionsName: "mainSessionOptions", hostName: "host", modelField: "subagentModelId" });
    const bytes = Buffer.from(LIVE_SHAPED_HOST, "utf8");
    expect(sha256Text(bytes.subarray(create[0]!.startByte, create[0]!.endByte).toString("utf8"))).toBe(create[0]!.windowSha256);
    expect(LIVE_SHAPED_HOST.slice(
      LIVE_SHAPED_HOST.indexOf("createSession"),
      LIVE_SHAPED_HOST.indexOf("recordPostTurnLabeling"),
    ).includes("createCursorInferencePromptSession")).toBe(true);
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
    const min = minifyOutsideStrings(reordered);
    for (const source of [renamed, crlf, unicode, reordered, min]) {
      const report = structuralShapeSync(source);
      expect(report.status, source.slice(0, 40)).toBe("ok");
      const create = report.candidates.find((row) => row.sliceId === "create-session");
      expect(create?.params?.[0]).toBe("cb");
      expect(create?.params?.[1]).toBe("opts");
      expect(report.candidates.some((row) => row.sliceId === "agent-id")).toBe(true);
    }
  });

  test("two-arg decoy, string/regex fakes, and shadowed host stay ambiguous or unused", () => {
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
    const decoyReport = structuralShapeSync(decoy);
    const creates = decoyReport.candidates.filter((row) => row.sliceId === "create-session");
    expect(creates.length).toBeGreaterThan(1);
    expect(creates.every((row) => row.limitations.includes("ambiguous-site"))).toBe(true);

    const stringy = `const decoy = "createSession(onRequestId, sessionOptions) { return createCursorInferencePromptSession(x); }";\n${LIVE_SHAPED_HOST}`;
    const stringReport = structuralShapeSync(stringy);
    expect(stringReport.candidates.filter((row) => row.sliceId === "create-session")).toHaveLength(1);

    const regex = LIVE_SHAPED_HOST.replace(
      "function runTurn(host) {",
      "const fake = /createSession(onRequestId, sessionOptions)/;\nfunction runTurn(host) {",
    );
    const regexReport = structuralShapeSync(regex);
    expect(regexReport.candidates.filter((row) => row.sliceId === "create-session")).toHaveLength(1);
  });

  test("grammar error and worker timeout are unavailable; worker is reaped", async () => {
    const bad = structuralShapeSync("const x = \"unterminated");
    expect(bad.status).toBe("unavailable");
    expect(bad.reason).toBe("grammar_error");
    expect(bad.limitations).toContain("syntaxUnverified");

    const prev = process.env.GROKBOX_SHAPE_WORKER_STALL;
    process.env.GROKBOX_SHAPE_WORKER_STALL = "1";
    try {
      const hung = await runStructuralShape("const x = 1;\n", { timeoutMs: 80 });
      expect(hung.status).toBe("unavailable");
      expect(hung.reason).toBe("timeout");
    } finally {
      if (prev === undefined) delete process.env.GROKBOX_SHAPE_WORKER_STALL;
      else process.env.GROKBOX_SHAPE_WORKER_STALL = prev;
    }
  });

  test("preload and host compile-hook do not import the shape worker", () => {
    const preload = readFileSync(join(repoRoot, "packages/box-runtime/src/preload.ts"), "utf8");
    const compile = readFileSync(join(repoRoot, "packages/box-runtime/src/internal/host/compile-hook.ts"), "utf8");
    for (const src of [preload, compile]) {
      expect(src).not.toContain("shape-worker");
      expect(src).not.toContain("host-seam/shape");
      expect(src).not.toContain("acorn");
    }
  });
});
