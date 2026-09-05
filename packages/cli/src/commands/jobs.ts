import { randomUUID } from "node:crypto";
import type { CliDeps } from "../deps.ts";
import type { JobLogEvent, JobProjection, JobState } from "../daemon/jobs.ts";
import { CliError, usage } from "../errors.ts";
import { GatewayClient } from "../gateway.ts";
import { formatTable, writeSuccess } from "../output.ts";
import { ioFromOpts } from "../opts.ts";
import { isRecord, parseInteger } from "../util.ts";

export type JobsOptions = {
  json?: boolean; table?: boolean; timeoutMs?: string; state?: string;
  limit?: string; offset?: string; limitBytes?: string; follow?: boolean;
};
const STATES = new Set<JobState>(["queued", "running", "succeeded", "failed", "cancelled", "interrupted", "unknown"]);

const PROJECTION_KEYS = new Set([
  "jobId", "state", "createdAt", "startedAt", "finishedAt", "cwd", "command", "output", "runTimeoutMs",
  "exitCode", "signal", "reason", "cancelOperationId", "logs",
]);

function canonicalBase64(value: string, bytes: number): boolean {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  const decoded = Buffer.from(value, "base64");
  return decoded.length === bytes && decoded.toString("base64") === value;
}

export function validateJobProjection(value: unknown, expectedJobId?: string): JobProjection {
  if (!isRecord(value) || Object.keys(value).some((key) => !PROJECTION_KEYS.has(key)) ||
    typeof value.jobId !== "string" || (expectedJobId !== undefined && value.jobId !== expectedJobId) ||
    typeof value.state !== "string" || !STATES.has(value.state as JobState) ||
    typeof value.createdAt !== "number" || !Number.isSafeInteger(value.createdAt) ||
    (value.startedAt !== undefined && (typeof value.startedAt !== "number" || !Number.isSafeInteger(value.startedAt))) ||
    (value.finishedAt !== undefined && (typeof value.finishedAt !== "number" || !Number.isSafeInteger(value.finishedAt))) ||
    typeof value.cwd !== "string" || !isRecord(value.command) ||
    JSON.stringify(Object.keys(value.command).sort()) !== JSON.stringify(["argumentCount", "executable", "shell"]) ||
    typeof value.command.executable !== "string" || typeof value.command.argumentCount !== "number" || !Number.isSafeInteger(value.command.argumentCount) ||
    typeof value.command.shell !== "boolean" || (value.output !== "capture" && value.output !== "discard") ||
    typeof value.runTimeoutMs !== "number" || !Number.isSafeInteger(value.runTimeoutMs) || !isRecord(value.logs) ||
    JSON.stringify(Object.keys(value.logs).sort()) !== JSON.stringify(["bytes", "nextOffset", "truncated"]) ||
    typeof value.logs.bytes !== "number" || !Number.isSafeInteger(value.logs.bytes) || value.logs.bytes < 0 ||
    typeof value.logs.nextOffset !== "number" || !Number.isSafeInteger(value.logs.nextOffset) || value.logs.nextOffset < 0 ||
    value.logs.bytes !== value.logs.nextOffset ||
    typeof value.logs.truncated !== "boolean" ||
    (value.exitCode !== undefined && (typeof value.exitCode !== "number" || !Number.isInteger(value.exitCode))) ||
    (value.signal !== undefined && typeof value.signal !== "string") ||
    (value.reason !== undefined && typeof value.reason !== "string") ||
    (value.cancelOperationId !== undefined && typeof value.cancelOperationId !== "string")) {
    throw new CliError("daemon_unreachable", "Daemon returned an invalid Job projection.");
  }
  return value as JobProjection;
}

async function client(deps: CliDeps, timeoutMs: number) {
  return await new GatewayClient(deps).daemonCapability("host.process.manage", timeoutMs);
}

export async function runJobsList(deps: CliDeps, raw: JobsOptions): Promise<void> {
  const io = ioFromOpts(raw);
  const states = raw.state ? raw.state.split(",").filter(Boolean) as JobState[] : [];
  if (states.some((state) => !STATES.has(state))) throw usage("--state contains an invalid Job state.");
  const limit = parseInteger(raw.limit, { name: "--limit", min: 1, max: 256, defaultValue: 50 });
  const result = (await (await client(deps, io.timeoutMs)).call("jobList", { states, limit })).result;
  if (!isRecord(result) || JSON.stringify(Object.keys(result)) !== JSON.stringify(["jobs"]) || !Array.isArray(result.jobs)) throw new CliError("daemon_unreachable", "Daemon returned an invalid Job list.");
  const jobs = result.jobs.map((value) => validateJobProjection(value));
  if (io.table) {
    deps.stdout.write(formatTable(jobs.map((value) => ({
      jobId: value.jobId, state: value.state, command: value.command?.executable ?? "",
      createdAt: new Date(value.createdAt).toISOString(),
    }))));
  } else writeSuccess(deps.stdout, { jobs });
}

export async function runJobsShow(deps: CliDeps, jobId: string, raw: JobsOptions): Promise<void> {
  const io = ioFromOpts(raw);
  if (io.table) throw usage("jobs show does not support --table.");
  writeSuccess(deps.stdout, validateJobProjection((await (await client(deps, io.timeoutMs)).call("jobShow", { jobId, waitMs: 0 })).result, jobId));
}

export async function runJobsLogs(deps: CliDeps, jobId: string, raw: JobsOptions): Promise<void> {
  const io = ioFromOpts(raw);
  if (io.table || io.json) throw usage("jobs logs emits NDJSON and does not support --json or --table.");
  if (raw.follow && io.timeoutMs < 1_000) throw usage("jobs logs --follow requires --timeout-ms of at least 1000.");
  let offset = parseInteger(raw.offset, { name: "--offset", min: 0, max: Number.MAX_SAFE_INTEGER, defaultValue: 0 });
  const limitBytes = parseInteger(raw.limitBytes, { name: "--limit-bytes", min: 64 * 1024, max: 256 * 1024, defaultValue: 256 * 1024 });
  const daemon = await client(deps, io.timeoutMs);
  do {
    const result = (await daemon.call("jobLogsRead", { jobId, offset, limitBytes, waitMs: raw.follow ? Math.min(25_000, Math.max(0, io.timeoutMs - 100)) : 0 })).result;
    if (!isRecord(result) || JSON.stringify(Object.keys(result).sort()) !== JSON.stringify(["complete", "events", "jobId", "nextOffset", "offset", "state", "truncated"]) ||
      result.jobId !== jobId || result.offset !== offset || !Array.isArray(result.events) || typeof result.nextOffset !== "number" ||
      !Number.isSafeInteger(result.nextOffset) || result.nextOffset < offset || typeof result.complete !== "boolean" ||
      typeof result.truncated !== "boolean" || typeof result.state !== "string" || !STATES.has(result.state as JobState)) {
      throw new CliError("daemon_unreachable", "Daemon returned an invalid Job log page.");
    }
    let expectedCursor = offset;
    const validatedEvents: JobLogEvent[] = [];
    for (const event of result.events) {
      if (!isRecord(event) || JSON.stringify(Object.keys(event).sort()) !== JSON.stringify(["bytes", "contentBase64", "nextOffset", "observedAt", "offset", "stream"]) ||
        event.offset !== expectedCursor ||
        typeof event.nextOffset !== "number" || !Number.isSafeInteger(event.nextOffset) ||
        (event.stream !== "stdout" && event.stream !== "stderr") || typeof event.observedAt !== "number" || !Number.isSafeInteger(event.observedAt) ||
        typeof event.bytes !== "number" || !Number.isSafeInteger(event.bytes) || event.bytes < 1 ||
        event.nextOffset !== event.offset + event.bytes ||
        typeof event.contentBase64 !== "string" || !canonicalBase64(event.contentBase64, event.bytes)) {
        throw new CliError("daemon_unreachable", "Daemon returned an invalid Job log event.");
      }
      expectedCursor = event.nextOffset;
      validatedEvents.push({
        offset: event.offset, nextOffset: event.nextOffset, stream: event.stream,
        observedAt: event.observedAt, bytes: event.bytes, contentBase64: event.contentBase64,
      });
    }
    if (result.nextOffset !== expectedCursor) {
      throw new CliError("daemon_unreachable", "Daemon returned a non-contiguous Job log page.");
    }
    for (const event of validatedEvents) deps.stdout.write(`${JSON.stringify(event)}\n`);
    if (result.nextOffset === offset && (!raw.follow || result.complete)) break;
    offset = result.nextOffset;
    if (!raw.follow || result.complete) break;
  } while (true);
}

export async function runJobsCancel(deps: CliDeps, jobId: string, raw: JobsOptions): Promise<void> {
  const io = ioFromOpts(raw);
  if (io.table) throw usage("jobs cancel does not support --table.");
  const cancelOperationId = randomUUID();
  const daemon = await client(deps, io.timeoutMs);
  try {
    writeSuccess(deps.stdout, validateJobProjection((await daemon.call("jobCancel", { jobId, cancelOperationId })).result, jobId));
  } catch (error) {
    if (!(error instanceof CliError) || error.code !== "operation_outcome_unknown") throw error;
    const current = validateJobProjection((await daemon.call("jobShow", { jobId, waitMs: 0 })).result, jobId);
    if (current.cancelOperationId !== cancelOperationId) throw error;
    writeSuccess(deps.stdout, current);
  }
}
