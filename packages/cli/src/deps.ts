import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import cliPackage from "../../../package.json" with { type: "json" };
import type { DesktopIo } from "./daemon/desktop.ts";
import { DEFAULT_AGENT_DATA_ROOT, DEFAULT_DISCOVERY_PATH } from "./registry.ts";
import type { Writable } from "./output.ts";
import { writeStreamOutput } from "./stream-output.ts";

export type FetchFn = typeof fetch;

export type CommandResult = { code: number; stdout: string; stderr: string };

export type CommandOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
};

export type CliDeps = {
  discoveryPath: string;
  fetch: FetchFn;
  now: () => number;
  randomUUID: () => string;
  readFile: (path: string) => Promise<string>;
  stdout: Writable;
  stderr: Writable;
  stdinIsTTY: boolean;
  readStdin: (maxBytes?: number) => Promise<string>;
  skillsDir: string;
  packageRoot: string;
  cliVersion: string;
  idleWatchdogMs: number;
  signal?: AbortSignal;
  configDir: string;
  boxRuntimeRoot: string;
  env: Readonly<Record<string, string | undefined>>;
  runCommand: (argv: readonly string[], options?: CommandOptions) => Promise<CommandResult>;
  wait: (ms: number, signal?: AbortSignal) => Promise<boolean>;
  transport: "auto" | "local" | "daemon" | "gateway";
  desktopIo?: DesktopIo;
  daemonSocket: string;
  daemonServerUrl?: string;
  daemonTokenRef?: string;
  daemonToken?: string;
  profileName?: string;
  sshHost?: string;
  sandboxAccessTokenRef?: string;
  sandboxKeepaliveIntervalMs?: number;
  quotaSource?: "cursor-web";
  quotaAccessTokenRef?: string;
  gatewayServerUrl?: string;
  gatewayTokenRef?: string;
  gatewayHeadersRef?: string;
  confirm: (prompt: string) => Promise<boolean>;
  agentDataRoot: string;
};

export const CLI_VERSION: string = cliPackage.version;

/** Published install root (`dist/`) or repo root when running `packages/cli/src`. */
export function resolvePackageRoot(moduleDir: string): string {
  if (basename(moduleDir) === "dist") return dirname(moduleDir);
  if (basename(moduleDir) === "src" && basename(dirname(moduleDir)) === "cli") {
    return dirname(dirname(dirname(moduleDir)));
  }
  return dirname(moduleDir);
}

async function readAllStdin(maxBytes = 16 * 1024 * 1024, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const cancel = () => process.stdin.destroy(new Error("Command input was interrupted."));
  signal?.addEventListener("abort", cancel, { once: true });
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of process.stdin) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxBytes) { process.stdin.destroy(); throw new Error("Command input exceeds its byte limit."); }
      chunks.push(buffer);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } finally { signal?.removeEventListener("abort", cancel); }
}

async function runProcess(argv: readonly string[], options: CommandOptions = {}): Promise<CommandResult> {
  const [file, ...args] = argv;
  if (!file) return { code: 127, stdout: "", stderr: "Missing executable." };
  const timeoutMs = options.timeoutMs ?? 300_000;
  const maxOutputBytes = options.maxOutputBytes ?? 8 * 1024 * 1024;
  return await new Promise((resolve) => {
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let terminationCode: number | undefined;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const cleanup = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
    };
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ code, stdout, stderr });
    };
    const terminate = (code: number, message: string) => {
      if (settled || terminationCode !== undefined) return;
      terminationCode = code;
      stderr = stderr || message;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
    };
    const abort = () => terminate(130, "Command cancelled.");
    const timer = setTimeout(() => terminate(124, "Command timed out."), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > maxOutputBytes) terminate(70, "Command output exceeded the byte limit.");
      else stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > maxOutputBytes) terminate(70, "Command output exceeded the byte limit.");
      else stderr += chunk;
    });
    child.on("error", (error) => {
      if (!stderr) stderr = error.message;
      finish(terminationCode ?? 127);
    });
    child.on("close", (code) => finish(terminationCode ?? code ?? 1));
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
  });
}

async function wait(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false;
  return await new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve(true);
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export function createProductionDeps(signal?: AbortSignal): CliDeps {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const configuredDir = process.env.GROKBOX_CONFIG_DIR;
  const configDir = configuredDir && isAbsolute(configuredDir)
    ? configuredDir
    : join(homedir(), ".grokbox");
  return {
    discoveryPath: DEFAULT_DISCOVERY_PATH,
    fetch: globalThis.fetch.bind(globalThis),
    now: () => Date.now(),
    randomUUID,
    readFile: async (path) => await readFile(path, "utf8"),
    stdout: {
      writeAsync: (chunk, signal) => writeStreamOutput(process.stdout, chunk, signal),
      write(chunk) {
        process.stdout.write(chunk);
      },
    },
    stderr: {
      write(chunk) {
        process.stderr.write(chunk);
      },
    },
    stdinIsTTY: Boolean(process.stdin.isTTY),
    readStdin: maxBytes => readAllStdin(maxBytes, signal),
    skillsDir: join(resolvePackageRoot(moduleDir), "skills"),
    packageRoot: resolvePackageRoot(moduleDir),
    cliVersion: CLI_VERSION,
    idleWatchdogMs: 45_000,
    ...(signal ? { signal } : {}),
    configDir,
    boxRuntimeRoot: process.env.GROKBOX_BOX_RUNTIME_ROOT && isAbsolute(process.env.GROKBOX_BOX_RUNTIME_ROOT)
      ? process.env.GROKBOX_BOX_RUNTIME_ROOT
      : "/workspace/.grokbox/box-runtime",
    agentDataRoot: DEFAULT_AGENT_DATA_ROOT,
    env: process.env,
    runCommand: runProcess,
    wait,
    transport: "auto",
    daemonSocket: join(configDir, "run", "daemon.sock"),
    confirm: async (prompt) => {
      if (signal?.aborted) return false;
      const terminal = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return await new Promise<boolean>((resolve, reject) => {
          const onAbort = () => resolve(false);
          signal?.addEventListener("abort", onAbort, { once: true });
          terminal.question(prompt).then((answer) => {
            signal?.removeEventListener("abort", onAbort);
            resolve(answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes");
          }, (error) => {
            signal?.removeEventListener("abort", onAbort);
            if (error instanceof Error && error.name === "AbortError") resolve(false);
            else reject(error);
          });
        });
      } finally {
        terminal.close();
      }
    },
  };
}
