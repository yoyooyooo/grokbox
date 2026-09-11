import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import { SHAPE_ENGINE, shapeFromSource, type ShapeReport } from "./shape-worker.ts";

export { SHAPE_ENGINE, shapeFromSource, type ShapeCandidate, type ShapeReport } from "./shape-worker.ts";

export const SHAPE_TOOL_REVISION = "hso-4.shape.lexical-cjs.v1";
export const SHAPE_TIMEOUT_MS = 45_000;
const WORKER = fileURLToPath(new URL("./shape-worker.ts", import.meta.url));

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

/** In-process lexical shape. Tests may call this; production ops should prefer the worker. */
export function structuralShapeSync(source: string): ShapeReport {
  return verifyUtf8Windows(source, shapeFromSource(source));
}

/** Owned worker. Timeout/OOM/crash → unavailable; parent always reaps. Host signals stay 0. */
export function runStructuralShape(source: string, options: { timeoutMs?: number } = {}): Promise<ShapeReport> {
  const timeoutMs = options.timeoutMs ?? SHAPE_TIMEOUT_MS;
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
        engine: SHAPE_ENGINE,
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
        engine: SHAPE_ENGINE,
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
          engine: SHAPE_ENGINE,
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
          engine: SHAPE_ENGINE,
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
