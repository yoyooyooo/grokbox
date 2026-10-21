import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import type { CliDeps } from "./deps.ts";
import { CliError } from "./errors.ts";
import { GatewayClient, readDiscovery, type Discovery } from "./gateway.ts";
import { DEFAULT_SERVER_BACKEND_URL } from "./server-routines.ts";
import { isRecord } from "./util.ts";

export type BoxHostProcess = { uid: number; start: string; cmdline: string };
/** Internal provider seam. Never returns process data to command output. */
export type BoxRoutineAuthIO = {
  platform: string;
  uid: number;
  process: (pid: number) => Promise<BoxHostProcess>;
  environment: (pid: number) => Promise<Buffer>;
};
export type BoxRoutineAuth = { backendUrl: string; token: string; credentialScope: string };
const ENV_LIMIT = 256 * 1024;
const RESPONSE_LIMIT = 32 * 1024;

async function boundedFile(path: string, limit: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) throw new Error("bounded process read");
    return buffer.subarray(0, length);
  } finally { await handle.close(); }
}
const productionIO: BoxRoutineAuthIO = {
  platform: process.platform,
  uid: process.getuid?.() ?? -1,
  async process(pid) {
    const root = `/proc/${pid}`;
    const metadata = await stat(root);
    const status = (await boundedFile(`${root}/status`, 32 * 1024)).toString("utf8");
    const uids = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/m.exec(status);
    if (!uids || uids.slice(1).some((uid) => Number(uid) !== metadata.uid)) throw new Error("process owner");
    const raw = (await boundedFile(`${root}/stat`, 8192)).toString("utf8");
    const start = raw.slice(raw.lastIndexOf(")") + 2).split(" ")[19];
    if (!start || !/^\d+$/.test(start)) throw new Error("process start");
    return { uid: metadata.uid, start, cmdline: (await boundedFile(`${root}/cmdline`, 8192)).toString("utf8") };
  },
  environment: async (pid) => await boundedFile(`/proc/${pid}/environ`, ENV_LIMIT),
};

export function nativeRoutineAuthEligible(deps: CliDeps): boolean {
  return (deps.boxRoutineAuthIO ?? productionIO).platform === "linux" &&
    (deps.transport === "auto" || deps.transport === "local") &&
    !deps.gatewayServerUrl && !deps.daemonServerUrl && !deps.sshHost;
}
function validHost(value: BoxHostProcess, uid: number): boolean {
  const args = value.cmdline.split("\0");
  if (args.at(-1) === "") args.pop();
  return uid >= 0 && value.uid === uid && /^\d+$/.test(value.start) &&
    args[0] === "/exec-daemon/node" && args.at(-1) === "/opt/sand/sand-host/host-main.cjs" &&
    args.slice(1, -1).every((arg) => arg === "--disable-warning=ExperimentalWarning");
}
function sameDiscovery(a: Discovery, b: Discovery): boolean {
  return a.pid === b.pid && a.startedAt === b.startedAt && a.baseUrl === b.baseUrl && a.token === b.token;
}
function failure(code: string): CliError {
  return new CliError("credential_invalid", "Current-box Routine authentication could not be established safely.", { failureCode: code });
}

/** Null retains the legacy Gateway path when current-box proof is unavailable. */
export async function resolveBoxRoutineAuth(deps: CliDeps, timeoutMs: number): Promise<BoxRoutineAuth | null> {
  if (!nativeRoutineAuthEligible(deps)) return null;
  if (deps.signal?.aborted) throw failure("request_cancelled");
  const io = deps.boxRoutineAuthIO ?? productionIO;
  let discovery: Discovery;
  let environment: Buffer;
  try {
    discovery = await readDiscovery(deps);
    if (!Number.isSafeInteger(discovery.pid) || discovery.pid <= 0 ||
        !Number.isSafeInteger(discovery.startedAt) || discovery.startedAt <= 0) return null;
    const before = await io.process(discovery.pid);
    if (!validHost(before, io.uid)) return null;
    // Force a direct local Gateway health check: auto must not select a daemon.
    const healthy = await new GatewayClient({ ...deps, transport: "local" }).health(timeoutMs);
    if (!sameDiscovery(discovery, healthy.discovery) || healthy.health.pid !== discovery.pid ||
        healthy.health.startedAt !== discovery.startedAt) return null;
    environment = await io.environment(discovery.pid);
    const after = await io.process(discovery.pid);
    if (!validHost(after, io.uid) || before.start !== after.start || before.cmdline !== after.cmdline ||
        !sameDiscovery(discovery, await readDiscovery(deps))) return null;
  } catch {
    if (deps.signal?.aborted) throw failure("request_cancelled");
    return null;
  }
  if (environment.length > ENV_LIMIT) throw failure("renewal_credential_oversized");
  const entries = environment.toString("utf8").split("\0").filter((entry) => entry.startsWith("SAND_INFERENCE_RENEWAL_CREDENTIAL="));
  if (entries.length === 0) return null;
  const credential = entries[0]!.slice("SAND_INFERENCE_RENEWAL_CREDENTIAL=".length).trim();
  if (entries.length !== 1 || !credential || Buffer.byteLength(credential) > 16 * 1024 || /[\r\n]/.test(credential)) {
    throw failure("renewal_credential_invalid");
  }
  const metadata: Record<string, string> = {};
  for (const entry of environment.toString("utf8").split("\0")) {
    const separator = entry.indexOf("=");
    const key = entry.slice(0, separator);
    if (!["SAND_CLIENT_APP_VERSION", "SAND_BOX_OWNER_NAMESPACE", "SAND_BACKEND_URL", "CURSOR_API_BASE_URL", "SAND_PACKAGED", "SAND_LAB"].includes(key)) continue;
    const value = entry.slice(separator + 1);
    if (metadata[key] !== undefined || value.length > 1024 || /[^\x20-\x7e]/.test(value)) throw failure("renewal_metadata_invalid");
    metadata[key] = value;
  }
  for (const key of ["SAND_BACKEND_URL", "CURSOR_API_BASE_URL"]) {
    const origin = metadata[key];
    if (origin && origin !== DEFAULT_SERVER_BACKEND_URL && origin !== `${DEFAULT_SERVER_BACKEND_URL}/`) throw failure("renewal_backend_unsupported");
  }
  const ownerNamespace = metadata.SAND_BOX_OWNER_NAMESPACE?.trim();
  if (metadata.SAND_PACKAGED !== "1" || metadata.SAND_LAB === "1" || ownerNamespace === "dev" || ownerNamespace === "lab") {
    throw failure("renewal_namespace_unsupported");
  }
  const namespace = "prod";
  // Native protocol fallback from sand-client-metadata, not grokbox's package version.
  const clientVersion = /^(\d+\.\d+\.\d+)(?:-.+)?$/.exec(metadata.SAND_CLIENT_APP_VERSION?.trim() ?? "")?.[1] ?? "0.1.0";
  const credentialScope = createHash("sha256").update(JSON.stringify([
    "box-routine-auth-v1", DEFAULT_SERVER_BACKEND_URL, namespace, credential,
  ])).digest("hex");
  const controller = new AbortController();
  const abort = () => controller.abort();
  deps.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  try {
    if (deps.signal?.aborted) controller.abort();
    if (controller.signal.aborted) throw failure("request_cancelled");
    const response = await deps.fetch(`${DEFAULT_SERVER_BACKEND_URL}/sand-box/inference-credential`, {
      method: "POST", headers: {
        "content-type": "application/json", "x-cursor-client-type": "sand", "x-cursor-client-source": "sand-desktop",
        "x-cursor-client-version": clientVersion,
        "x-sand-box-namespace": namespace,
      },
      body: JSON.stringify({ credential }), redirect: "manual", cache: "no-store", signal: controller.signal,
    });
    if (response.redirected || !response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw failure(response.status >= 300 && response.status < 400 ? "renewal_redirect_refused" :
        response.status === 401 || response.status === 403 ? "renewal_unauthorized" : "renewal_unavailable");
    }
    const declared = response.headers.get("content-length");
    if (declared !== null && (!Number.isSafeInteger(Number(declared)) || Number(declared) < 0 || Number(declared) > RESPONSE_LIMIT)) {
      await response.body?.cancel().catch(() => undefined);
      throw failure("renewal_response_oversized");
    }
    const reader = response.body?.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      if (reader) for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > RESPONSE_LIMIT) { await reader.cancel().catch(() => undefined); throw failure("renewal_response_oversized"); }
        chunks.push(Buffer.from(next.value));
      }
    } finally { reader?.releaseLock(); }
    if (controller.signal.aborted) throw failure("request_cancelled");
    const result: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    let expiresAtMs = isRecord(result) ? result.expiresAtMs : undefined;
    if (expiresAtMs === undefined && isRecord(result) && typeof result.accessToken === "string") {
      try {
        const payload: unknown = JSON.parse(Buffer.from(result.accessToken.split(".")[1] ?? "", "base64url").toString("utf8"));
        if (isRecord(payload) && typeof payload.exp === "number") expiresAtMs = payload.exp * 1000;
      } catch { /* A ticket without a bounded expiry is not accepted. */ }
    }
    if (!isRecord(result) || typeof result.accessToken !== "string" || !result.accessToken ||
        Buffer.byteLength(result.accessToken) > 16 * 1024 || /[\s\0]/.test(result.accessToken) ||
        typeof expiresAtMs !== "number" || !Number.isSafeInteger(expiresAtMs) || expiresAtMs <= deps.now() + 30_000) {
      throw failure("renewal_response_invalid");
    }
    return { backendUrl: DEFAULT_SERVER_BACKEND_URL, token: result.accessToken, credentialScope };
  } catch (error) {
    if (controller.signal.aborted) throw failure("request_cancelled");
    if (error instanceof CliError) throw error;
    throw failure("renewal_response_invalid");
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener("abort", abort);
  }
}
