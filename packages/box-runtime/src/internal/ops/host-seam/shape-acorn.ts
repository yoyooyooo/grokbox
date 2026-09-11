import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import {
  ACORN_SHAPE_ENGINE,
  acornShapeFromSource,
} from "./shape-acorn-worker.ts";
import type { ShapeCandidate, ShapeReport } from "./shape-worker.ts";

export { ACORN_ECMA, ACORN_SHAPE_ENGINE, ACORN_VERSION, acornShapeFromSource } from "./shape-acorn-worker.ts";

export const ACORN_TOOL_REVISION = "hso-4.shape.acorn.v1";
export const ACORN_TIMEOUT_MS = 45_000;
const WORKER = fileURLToPath(new URL("./shape-acorn-worker.ts", import.meta.url));

function verifyUtf8Windows(source: string, report: ShapeReport): ShapeReport {
  const bytes = Buffer.from(source, "utf8");
  if (report.utf8Bytes !== bytes.length) {
    return { ...report, status: "unavailable", reason: "grammar_error", limitations: [...report.limitations, "utf8_length_mismatch"] };
  }
  for (const row of report.candidates) {
    if (row.startByte < 0 || row.endByte > bytes.length || row.endByte < row.startByte) {
      return { ...report, status: "unavailable", reason: "grammar_error", limitations: [...report.limitations, "utf8_range"] };
    }
    const window = bytes.subarray(row.startByte, row.endByte).toString("utf8");
    if (sha256Text(window) !== row.windowSha256) {
      return { ...report, status: "unavailable", reason: "grammar_error", limitations: [...report.limitations, "window_hash_mismatch"] };
    }
  }
  return report;
}

export function acornShapeSync(source: string): ShapeReport {
  return verifyUtf8Windows(source, acornShapeFromSource(source));
}

/** Owned worker. Timeout/OOM/crash → unavailable; parent always reaps. Host signals stay 0. */
export function runAcornShape(source: string, options: { timeoutMs?: number } = {}): Promise<ShapeReport> {
  const timeoutMs = options.timeoutMs ?? ACORN_TIMEOUT_MS;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WORKER], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    let stdout = "";
    let settled = false;
    const finish = (report: ShapeReport) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill("SIGKILL"); } catch { /* reaped */ }
      resolve(report);
    };
    const timer = setTimeout(() => {
      finish({
        status: "unavailable",
        reason: "timeout",
        engine: ACORN_SHAPE_ENGINE,
        utf8Bytes: Buffer.byteLength(source, "utf8"),
        candidates: [],
        truncated: false,
        limitations: ["timeout"],
      });
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", () => {
      finish({
        status: "unavailable",
        reason: "grammar_error",
        engine: ACORN_SHAPE_ENGINE,
        utf8Bytes: Buffer.byteLength(source, "utf8"),
        candidates: [],
        truncated: false,
        limitations: ["worker_spawn_failed"],
      });
    });
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0 && stdout.length === 0) {
        finish({
          status: "unavailable",
          reason: code === 137 || code === 9 ? "oom" : "grammar_error",
          engine: ACORN_SHAPE_ENGINE,
          utf8Bytes: Buffer.byteLength(source, "utf8"),
          candidates: [],
          truncated: false,
          limitations: ["worker_exit"],
        });
        return;
      }
      try {
        const report = JSON.parse(stdout) as ShapeReport;
        finish(verifyUtf8Windows(source, report));
      } catch {
        finish({
          status: "unavailable",
          reason: "grammar_error",
          engine: ACORN_SHAPE_ENGINE,
          utf8Bytes: Buffer.byteLength(source, "utf8"),
          candidates: [],
          truncated: false,
          limitations: ["worker_output"],
        });
      }
    });
    child.stdin?.write(JSON.stringify({ source }));
    child.stdin?.end();
  });
}

function keyOf(row: ShapeCandidate): string {
  return `${row.sliceId}:${row.startByte}:${row.endByte}`;
}

/**
 * AST is evidence, not a monopoly. Disagreement is reported; neither engine is auto-selected.
 * Does not emit SlicePatch or rewrite Host.
 */
export function compareShapeEngines(lexical: ShapeReport, acorn: ShapeReport): {
  agree: boolean;
  onlyLexical: string[];
  onlyAcorn: string[];
  limitations: string[];
} {
  const lex = new Set(lexical.candidates.map(keyOf));
  const ac = new Set(acorn.candidates.map(keyOf));
  const onlyLexical = [...lex].filter((key) => !ac.has(key));
  const onlyAcorn = [...ac].filter((key) => !lex.has(key));
  const agree = onlyLexical.length === 0 && onlyAcorn.length === 0 && lexical.status === acorn.status;
  return {
    agree,
    onlyLexical,
    onlyAcorn,
    limitations: agree ? [] : ["ast_not_monopoly"],
  };
}
