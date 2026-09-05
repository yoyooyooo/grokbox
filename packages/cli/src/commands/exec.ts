import { randomUUID } from "node:crypto";
import type { CliDeps } from "../deps.ts";
import { validateJobProjection } from "./jobs.ts";
import { CliError, usage } from "../errors.ts";
import { GatewayClient } from "../gateway.ts";
import { writeSuccess } from "../output.ts";
import { ioFromOpts } from "../opts.ts";
import { parseInteger } from "../util.ts";

export type ExecOptions = {
  json?: boolean;
  table?: boolean;
  timeoutMs?: string;
  cwd?: string;
  env?: string[];
  runTimeoutMs?: string;
  output?: string;
  detach?: boolean;
  shell?: boolean;
};

export async function runExec(deps: CliDeps, argv: string[], raw: ExecOptions): Promise<void> {
  const io = ioFromOpts(raw);
  if (io.table) throw usage("exec run does not support --table.");
  const client = await new GatewayClient(deps).daemonCapability("host.process.run", io.timeoutMs);
  const authority = await client.handshake();
  const shell = Boolean(raw.shell);
  if (shell && !authority.capabilities.includes("host.process.shell")) {
    throw new CliError("capability_unavailable", "Daemon shell execution is not authorized.");
  }
  if (!Array.isArray(argv) || argv.length === 0) throw usage("Provide an executable alias and argv after --.");
  if (shell && argv.length !== 1) throw usage("--shell accepts exactly one command string after --.");
  const environment: Record<string, string> = {};
  for (const item of raw.env ?? []) {
    const separator = item.indexOf("=");
    if (separator < 1) throw usage("--env requires NAME=value.");
    const key = item.slice(0, separator);
    if (Object.hasOwn(environment, key)) throw usage(`--env ${key} was provided more than once.`);
    environment[key] = item.slice(separator + 1);
  }
  const output = raw.output ?? "capture";
  if (output !== "capture" && output !== "discard") throw usage("--output must be capture or discard.");
  const runTimeoutMs = parseInteger(raw.runTimeoutMs, { name: "--run-timeout-ms", min: 100, max: 86_400_000, defaultValue: 60_000 });
  const jobId = randomUUID();
  const params = {
    jobId, cwd: raw.cwd ?? null, argv, environment, runTimeoutMs, output, shell,
    expectedDaemonGeneration: authority.daemonGeneration,
    waitMs: raw.detach ? 0 : Math.max(0, io.timeoutMs - 100),
  };
  try {
    writeSuccess(deps.stdout, validateJobProjection((await client.call("jobSubmit", params)).result, jobId));
  } catch (error) {
    if (!(error instanceof CliError) || error.code !== "operation_outcome_unknown") throw error;
    try {
      const current = await client.handshake();
      if (current.daemonGeneration === authority.daemonGeneration) {
        writeSuccess(deps.stdout, validateJobProjection((await client.call("jobSubmit", params)).result, jobId));
        return;
      }
    } catch (retryError) {
      if (!(retryError instanceof CliError) ||
        (retryError.code !== "operation_outcome_unknown" && retryError.code !== "daemon_unreachable")) throw retryError;
    }
    try {
      writeSuccess(deps.stdout, validateJobProjection((await client.call("jobShow", { jobId, waitMs: 0 })).result, jobId));
    } catch {
      throw new CliError("operation_outcome_unknown", "Job submission could not be reconciled with the original daemon authority.", {
        context: { operationId: jobId },
      });
    }
  }
}
