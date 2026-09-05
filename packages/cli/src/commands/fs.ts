import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { CliDeps } from "../deps.ts";
import type { DaemonClient } from "../daemon/client.ts";
import {
  FS_DOWNLOAD_MAX_BYTES,
  FS_READ_MAX_BYTES,
  FS_TRANSFER_CHUNK_BYTES,
  FS_UPLOAD_MAX_BYTES,
  FS_WRITE_MAX_BYTES,
} from "../daemon/filesystem.ts";
import { CliError, EXIT_CODES, type ErrorCode, usage } from "../errors.ts";
import { GatewayClient } from "../gateway.ts";
import { flattenRows, formatTable, writeSuccess } from "../output.ts";
import { ioFromOpts } from "../opts.ts";
import { isRecord } from "../util.ts";

const FS_READ_CAPABILITY = "host.fs.read";
const FS_WRITE_CAPABILITY = "host.fs.write";

type FsOptions = {
  json?: boolean;
  table?: boolean;
  timeoutMs?: string;
  text?: string;
  expectedSha256?: string;
  recursive?: boolean;
  yes?: boolean;
};

type DownloadOpen = {
  transferId: string;
  path: string;
  root: string;
  size: number;
  sha256: string;
  chunkBytes: number;
  chunks: number;
};

function recordResult(value: unknown, operation: string): Record<string, unknown> {
  if (!isRecord(value)) throw new CliError("daemon_unreachable", `Daemon returned an invalid ${operation} result.`);
  return value;
}

function downloadOpen(
  value: unknown,
  expectedPath: string,
  expectedTransferId: string,
): DownloadOpen {
  const result = recordResult(value, "download open");
  if (
    result.transferId !== expectedTransferId ||
    result.path !== expectedPath || result.root !== expectedPath.split(":", 1)[0] ||
    typeof result.size !== "number" || !Number.isSafeInteger(result.size) || result.size < 0 ||
    result.size > FS_DOWNLOAD_MAX_BYTES ||
    typeof result.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(result.sha256) ||
    result.chunkBytes !== FS_TRANSFER_CHUNK_BYTES ||
    typeof result.chunks !== "number" || !Number.isSafeInteger(result.chunks) || result.chunks < 0 ||
    result.chunks !== Math.ceil(result.size / result.chunkBytes)
  ) {
    throw new CliError("daemon_unreachable", "Daemon returned invalid download metadata.");
  }
  return result as DownloadOpen;
}

async function filesystemClient(
  deps: CliDeps,
  timeoutMs: number,
  capability = FS_READ_CAPABILITY,
): Promise<DaemonClient> {
  return await new GatewayClient(deps).daemonCapability(capability, timeoutMs);
}

export async function runFsStat(deps: CliDeps, remotePath: string, raw: FsOptions): Promise<void> {
  const io = ioFromOpts(raw);
  const client = await filesystemClient(deps, io.timeoutMs);
  const data = recordResult((await client.call("fsStat", { path: remotePath })).result, "filesystem stat");
  if (io.table) {
    deps.stdout.write(formatTable(flattenRows(data) as Array<Record<string, string>>));
    return;
  }
  writeSuccess(deps.stdout, data);
}

export async function runFsList(deps: CliDeps, remotePath: string, raw: FsOptions): Promise<void> {
  const io = ioFromOpts(raw);
  const client = await filesystemClient(deps, io.timeoutMs);
  const data = recordResult((await client.call("fsList", { path: remotePath })).result, "filesystem list");
  if (!Array.isArray(data.entries)) {
    throw new CliError("daemon_unreachable", "Daemon returned an invalid filesystem list result.");
  }
  if (io.table) {
    deps.stdout.write(formatTable(data.entries.filter(isRecord).map((entry) => ({
      name: typeof entry.name === "string" ? entry.name : "",
      kind: typeof entry.kind === "string" ? entry.kind : "",
      size: typeof entry.size === "number" ? String(entry.size) : "",
      modifiedAt: typeof entry.modifiedAt === "string" ? entry.modifiedAt : "",
      path: typeof entry.path === "string" ? entry.path : "",
    }))));
    return;
  }
  writeSuccess(deps.stdout, data);
}

function validateRead(value: unknown, expectedPath: string): Record<string, unknown> {
  const data = recordResult(value, "filesystem read");
  if (
    data.path !== expectedPath || data.root !== expectedPath.split(":", 1)[0] ||
    (data.encoding !== "utf8" && data.encoding !== "base64") ||
    typeof data.content !== "string" ||
    typeof data.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(data.sha256) ||
    typeof data.size !== "number" || !Number.isSafeInteger(data.size) || data.size < 0 ||
    data.size > FS_READ_MAX_BYTES
  ) {
    throw new CliError("daemon_unreachable", "Daemon returned an invalid filesystem read result.");
  }
  let content: Buffer;
  if (data.encoding === "utf8") {
    content = Buffer.from(data.content, "utf8");
  } else {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data.content)) {
      throw new CliError("daemon_unreachable", "Daemon returned invalid base64 file content.");
    }
    content = Buffer.from(data.content, "base64");
  }
  if (content.length !== data.size || createHash("sha256").update(content).digest("hex") !== data.sha256) {
    throw new CliError("fs_hash_mismatch", "Daemon filesystem read content failed size or SHA-256 verification.");
  }
  return data;
}

export async function runFsRead(deps: CliDeps, remotePath: string, raw: FsOptions): Promise<void> {
  const io = ioFromOpts(raw);
  const client = await filesystemClient(deps, io.timeoutMs);
  const data = validateRead((await client.call("fsRead", { path: remotePath })).result, remotePath);
  writeSuccess(deps.stdout, data);
}

function decodeChunk(value: unknown, expectedTransferId: string, expectedIndex: number): Buffer {
  const result = recordResult(value, "download chunk");
  if (
    result.transferId !== expectedTransferId || result.index !== expectedIndex ||
    typeof result.bytes !== "number" || !Number.isSafeInteger(result.bytes) || result.bytes < 0 ||
    typeof result.contentBase64 !== "string" || typeof result.done !== "boolean" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(result.contentBase64)
  ) {
    throw new CliError("fs_transfer_invalid", "Daemon returned an invalid download chunk.");
  }
  const content = Buffer.from(result.contentBase64, "base64");
  if (content.length !== result.bytes) {
    throw new CliError("fs_transfer_invalid", "Daemon download chunk length does not match its envelope.");
  }
  return content;
}

export async function runFsDownload(
  deps: CliDeps,
  remotePath: string,
  localPath: string,
  raw: FsOptions,
): Promise<void> {
  const io = ioFromOpts(raw);
  const client = await filesystemClient(deps, io.timeoutMs);
  const destination = resolve(localPath);
  try {
    await lstat(destination);
    throw new CliError("fs_destination_exists", "Local download destination already exists.");
  } catch (error) {
    if (error instanceof CliError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new CliError("fs_forbidden", "Local download destination is unavailable.");
    }
  }

  const temporary = join(dirname(destination), `.${basename(destination)}.grokbox-${deps.randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600).catch(() => {
    throw new CliError("fs_forbidden", "Local download destination cannot be created.");
  });
  const hash = createHash("sha256");
  const transferId = deps.randomUUID();
  let opened: DownloadOpen | null = null;
  let received = 0;
  let completed = false;
  try {
    opened = downloadOpen(
      (await client.call("fsDownloadOpen", { path: remotePath, transferId })).result,
      remotePath,
      transferId,
    );
    for (let index = 0; index < opened.chunks; index += 1) {
      if (deps.signal?.aborted) throw new CliError("daemon_unreachable", "Download was cancelled.", { retryable: true });
      const result = await client.call("fsDownloadChunk", { transferId: opened.transferId, index });
      const content = decodeChunk(result.result, opened.transferId, index);
      const expected = Math.min(opened.chunkBytes, opened.size - received);
      const chunk = recordResult(result.result, "download chunk");
      if (content.length !== expected || chunk.done !== (index === opened.chunks - 1)) {
        throw new CliError("fs_transfer_invalid", "Daemon download chunk sequence is invalid.");
      }
      await handle.write(content, 0, content.length, received);
      hash.update(content);
      received += content.length;
    }
    if (received !== opened.size) throw new CliError("fs_transfer_invalid", "Downloaded byte count does not match metadata.");
    if (hash.digest("hex") !== opened.sha256) throw new CliError("fs_hash_mismatch", "Downloaded SHA-256 does not match metadata.");
    await handle.sync();
    await handle.close();
    await link(temporary, destination).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") throw new CliError("fs_destination_exists", "Local download destination already exists.");
      throw new CliError("fs_forbidden", "Downloaded file cannot be committed to its destination.");
    });
    completed = true;
    await rm(temporary, { force: true }).catch(() => undefined);
    writeSuccess(deps.stdout, {
      remotePath: opened.path,
      localPath: destination,
      size: received,
      sha256: opened.sha256,
      chunks: opened.chunks,
      verified: true,
    });
  } finally {
    if (!completed) {
      await handle.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
    await client.call(
      "fsDownloadCancel",
      { transferId },
      { ignoreSignal: true },
    ).catch(() => undefined);
  }
}

function expectedHash(value: string | undefined): string | undefined {
  if (value !== undefined && !/^[0-9a-f]{64}$/.test(value)) throw usage("--expected-sha256 must be 64 lowercase hexadecimal characters.");
  return value;
}

async function mutationCall(
  client: DaemonClient,
  method: "fsWrite" | "fsMkdir" | "fsUploadCommit" | "fsRemove",
  params: Record<string, unknown>,
  expectedPath: string,
  expectedFile?: { size: number; sha256: string },
): Promise<Record<string, unknown>> {
  const validate = (result: unknown) => {
    const record = recordResult(result, "filesystem mutation");
    const fields = method === "fsWrite" || method === "fsUploadCommit"
      ? ["operationId", "path", "replaced", "sha256", "size", "state"]
      : method === "fsMkdir"
        ? ["kind", "operationId", "path", "state"]
        : ["kind", "operationId", "path", "recoverable", "state", "trashId"];
    if (record.operationId !== params.operationId || record.state !== "committed" || record.path !== expectedPath ||
      JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(fields)) {
      throw new CliError("daemon_unreachable", "Daemon returned an invalid filesystem mutation result.");
    }
    if ((method === "fsWrite" || method === "fsUploadCommit") &&
      (typeof record.size !== "number" || !Number.isSafeInteger(record.size) || record.size < 0 ||
        typeof record.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(record.sha256) ||
        typeof record.replaced !== "boolean" ||
        (expectedFile !== undefined &&
          (record.size !== expectedFile.size || record.sha256 !== expectedFile.sha256)))) {
      throw new CliError("daemon_unreachable", "Daemon returned invalid file mutation metadata.");
    }
    if (method === "fsMkdir" && record.kind !== "directory") {
      throw new CliError("daemon_unreachable", "Daemon returned invalid mkdir metadata.");
    }
    if (method === "fsRemove" &&
      ((record.kind !== "file" && record.kind !== "directory") || record.recoverable !== true ||
        record.trashId !== params.operationId)) {
      throw new CliError("daemon_unreachable", "Daemon returned invalid recoverable remove metadata.");
    }
    return record;
  };
  try {
    return validate((await client.call(method, params)).result);
  } catch (error) {
    if (!(error instanceof CliError) ||
      (error.code !== "operation_outcome_unknown" && error.code !== "daemon_unreachable")) throw error;
    let status: Record<string, unknown>;
    try {
      status = recordResult(
        (await client.call("fsMutationStatus", { operationId: params.operationId }, { ignoreSignal: true })).result,
        "filesystem mutation status",
      );
    } catch {
      throw new CliError("operation_outcome_unknown", "Filesystem mutation response and reconciliation were both unavailable.", {
        context: { operationId: String(params.operationId) },
      });
    }
    if (status.operationId !== params.operationId) {
      throw new CliError("operation_outcome_unknown", "Filesystem mutation status identity did not match.", {
        context: { operationId: String(params.operationId) },
      });
    }
    if (status.state === "committed" && isRecord(status.result)) return validate(status.result);
    if ((status.state === "conflict" || status.state === "not_committed") && isRecord(status.error) &&
      typeof status.error.code === "string" && status.error.code !== "ok" && status.error.code in EXIT_CODES &&
      typeof status.error.message === "string") {
      throw new CliError(status.error.code as ErrorCode, status.error.message);
    }
    throw new CliError("operation_outcome_unknown", "Filesystem mutation outcome remains unknown.", {
      context: { operationId: String(params.operationId) },
    });
  }
}

export async function runFsWrite(deps: CliDeps, remotePath: string, raw: FsOptions): Promise<void> {
  const io = ioFromOpts(raw);
  const expectedSha256 = expectedHash(raw.expectedSha256);
  const client = await filesystemClient(deps, io.timeoutMs, FS_WRITE_CAPABILITY);
  let text: string;
  if (raw.text !== undefined) text = raw.text;
  else if (deps.stdinIsTTY) throw usage("Provide --text or pipe stdin.");
  else text = await deps.readStdin();
  const content = Buffer.from(text, "utf8");
  if (content.length > FS_WRITE_MAX_BYTES) throw usage("Text write exceeds the 1 MiB limit.");
  const sha256 = createHash("sha256").update(content).digest("hex");
  const operationId = deps.randomUUID();
  writeSuccess(deps.stdout, await mutationCall(client, "fsWrite", {
    operationId,
    path: remotePath,
    contentUtf8: text,
    ...(expectedSha256 ? { expectedSha256 } : {}),
  }, remotePath, { size: content.length, sha256 }));
}

export async function runFsMkdir(deps: CliDeps, remotePath: string, raw: FsOptions): Promise<void> {
  const io = ioFromOpts(raw);
  const client = await filesystemClient(deps, io.timeoutMs, FS_WRITE_CAPABILITY);
  const operationId = deps.randomUUID();
  writeSuccess(deps.stdout, await mutationCall(
    client,
    "fsMkdir",
    { operationId, path: remotePath },
    remotePath,
  ));
}

function sameLocalFile(left: { dev: number; ino: number; size: number; mtimeMs: number }, right: typeof left): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

export async function runFsUpload(
  deps: CliDeps,
  localPath: string,
  remotePath: string,
  raw: FsOptions,
): Promise<void> {
  const io = ioFromOpts(raw);
  const expectedSha256 = expectedHash(raw.expectedSha256);
  const client = await filesystemClient(deps, io.timeoutMs, FS_WRITE_CAPABILITY);
  const local = await open(resolve(localPath), constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ELOOP" || error.code === "EACCES" || error.code === "EPERM") {
      throw new CliError("fs_forbidden", "Local upload source is not an authorized regular file.");
    }
    throw new CliError("fs_not_found", "Local upload source cannot be opened.");
  });
  const operationId = deps.randomUUID();
  let uploadAttempted = false;
  try {
    const baseline = await local.stat();
    if (!baseline.isFile()) throw new CliError("fs_not_file", "Local upload source is not a regular file.");
    if (baseline.size > FS_UPLOAD_MAX_BYTES) throw new CliError("fs_too_large", "Local upload exceeds the 64 MiB limit.");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(FS_TRANSFER_CHUNK_BYTES);
    let offset = 0;
    while (offset < baseline.size) {
      const result = await local.read(buffer, 0, Math.min(buffer.length, baseline.size - offset), offset);
      if (result.bytesRead === 0) break;
      hash.update(buffer.subarray(0, result.bytesRead));
      offset += result.bytesRead;
    }
    if (offset !== baseline.size || !sameLocalFile(baseline, await local.stat())) {
      throw new CliError("fs_conflict", "Local upload source changed while hashing.");
    }
    const sha256 = hash.digest("hex");
    uploadAttempted = true;
    const opened = recordResult((await client.call("fsUploadOpen", {
      operationId,
      path: remotePath,
      size: baseline.size,
      sha256,
      ...(expectedSha256 ? { expectedSha256 } : {}),
    })).result, "upload open");
    if (opened.operationId !== operationId || opened.path !== remotePath ||
      opened.size !== baseline.size || opened.sha256 !== sha256 ||
      opened.chunkBytes !== FS_TRANSFER_CHUNK_BYTES || opened.chunks !== Math.ceil(baseline.size / FS_TRANSFER_CHUNK_BYTES)) {
      throw new CliError("daemon_unreachable", "Daemon returned invalid upload metadata.");
    }
    const chunks = Number(opened.chunks);
    for (let index = 0; index < chunks; index += 1) {
      if (deps.signal?.aborted) throw new CliError("daemon_unreachable", "Upload was cancelled.", { retryable: true });
      const length = Math.min(FS_TRANSFER_CHUNK_BYTES, baseline.size - index * FS_TRANSFER_CHUNK_BYTES);
      const content = Buffer.alloc(length);
      let bytesRead = 0;
      while (bytesRead < length) {
        const read = await local.read(
          content,
          bytesRead,
          length - bytesRead,
          index * FS_TRANSFER_CHUNK_BYTES + bytesRead,
        );
        if (read.bytesRead === 0) break;
        bytesRead += read.bytesRead;
      }
      if (bytesRead !== length) throw new CliError("fs_conflict", "Local upload source changed while reading.");
      const params = { operationId, index, bytes: length, contentBase64: content.toString("base64") };
      let response: unknown;
      try {
        response = (await client.call("fsUploadChunk", params)).result;
      } catch (error) {
        if (!(error instanceof CliError) || error.code !== "daemon_unreachable" || deps.signal?.aborted) throw error;
        response = (await client.call("fsUploadChunk", params)).result;
      }
      const accepted = recordResult(response, "upload chunk");
      if (accepted.operationId !== operationId || accepted.index !== index ||
        accepted.bytes !== length || accepted.accepted !== true || typeof accepted.repeated !== "boolean") {
        throw new CliError("daemon_unreachable", "Daemon returned an invalid upload chunk result.");
      }
    }
    if (!sameLocalFile(baseline, await local.stat())) throw new CliError("fs_conflict", "Local upload source changed before commit.");
    writeSuccess(deps.stdout, await mutationCall(
      client,
      "fsUploadCommit",
      { operationId },
      remotePath,
      { size: baseline.size, sha256 },
    ));
  } finally {
    await local.close().catch(() => undefined);
    if (uploadAttempted) await client.call("fsUploadCancel", { operationId }, { ignoreSignal: true }).catch(() => undefined);
  }
}

export async function runFsRemove(deps: CliDeps, remotePath: string, raw: FsOptions): Promise<void> {
  const io = ioFromOpts(raw);
  const gateway = new GatewayClient(deps);
  const client = await gateway.daemonCapability(FS_WRITE_CAPABILITY, io.timeoutMs);
  if (raw.recursive) await gateway.daemonCapability("host.fs.remove.recursive", io.timeoutMs);
  if (!raw.yes) {
    if (!deps.stdinIsTTY) throw usage("fs remove requires --yes in non-interactive mode.");
    if (!await deps.confirm(`Move '${remotePath}' to recoverable trash? [y/N] `)) throw usage("Filesystem remove was not confirmed.");
  }
  const operationId = deps.randomUUID();
  writeSuccess(deps.stdout, await mutationCall(client, "fsRemove", {
    operationId,
    path: remotePath,
    recursive: Boolean(raw.recursive),
  }, remotePath));
}
