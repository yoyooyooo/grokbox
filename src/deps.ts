import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import cliPackage from "../package.json" with { type: "json" };
import { DEFAULT_DISCOVERY_PATH } from "./registry.ts";
import type { Writable } from "./output.ts";

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
  readStdin: () => Promise<string>;
  skillsDir: string;
  packageRoot: string;
  cliVersion: string;
  idleWatchdogMs: number;
  signal?: AbortSignal;
  configDir: string;
  env: Readonly<Record<string, string | undefined>>;
  runCommand: (argv: readonly string[], options?: CommandOptions) => Promise<CommandResult>;
  wait: (ms: number, signal?: AbortSignal) => Promise<boolean>;
  transport: "auto" | "local" | "daemon" | "gateway";
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
};

export const CLI_VERSION: string = cliPackage.version;

async function readAllStdin(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input;
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
    readStdin: readAllStdin,
    skillsDir: join(moduleDir, "..", "skills"),
    packageRoot: join(moduleDir, ".."),
    cliVersion: CLI_VERSION,
    idleWatchdogMs: 45_000,
    ...(signal ? { signal } : {}),
    configDir,
    env: process.env,
    runCommand: runProcess,
    wait,
    transport: "auto",
    daemonSocket: join(configDir, "run", "daemon.sock"),
    confirm: async (prompt) => {
      const terminal = createInterface({ input: process.stdin, output: process.stderr });
      try {
        const answer = await terminal.question(prompt);
        return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
      } finally {
        terminal.close();
      }
    },
  };
}
