import { createHash, type Hash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { mkdir, open, opendir, realpath, rename, rmdir, stat, unlink, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { CliError, type ErrorCode } from "../errors.ts";
import type { DaemonFilesystemRootConfig } from "./config.ts";

export const FS_READ_MAX_BYTES = 1024 * 1024;
export const FS_DOWNLOAD_MAX_BYTES = 64 * 1024 * 1024;
export const FS_TRANSFER_CHUNK_BYTES = 256 * 1024;
export const FS_UPLOAD_MAX_BYTES = FS_DOWNLOAD_MAX_BYTES;
export const FS_WRITE_MAX_BYTES = FS_READ_MAX_BYTES;
export const FS_LIST_MAX_ENTRIES = 1000;
const MUTATION_TTL_MS = 10 * 60_000;
const MUTATION_MAX = 1_024;
const UPLOAD_MAX = 64;
const TRANSFER_TTL_MS = 60_000;
const TRANSFER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CANCELLED_TRANSFER_MAX = 1_024;
const REMOVE_MAX_ENTRIES = 10_000;
const REMOVE_MAX_DEPTH = 64;
const TRASH_DIRECTORY = ".grokbox-trash";

export type FilesystemOperation =
  | "stat" | "list" | "read" | "download"
  | "write" | "mkdir" | "upload" | "remove" | "remove-recursive" | "exec";

export type FilesystemRootProjection = {
  name: string;
  operations: readonly FilesystemOperation[];
};

export type ExecutionDirectory = {
  remotePath: string;
  descriptorPath: string;
  verify: () => Promise<void>;
  close: () => Promise<void>;
};

export type FilesystemEntry = {
  name: string;
  path: string;
  kind: "file" | "directory";
  size: number;
  mode: string;
  modifiedAt: string;
};

export type FilesystemStat = FilesystemEntry & {
  root: string;
  sha256: string | null;
};

export type FilesystemRead = {
  path: string;
  root: string;
  size: number;
  sha256: string;
  encoding: "utf8" | "base64";
  content: string;
};

export type DownloadOpen = {
  transferId: string;
  path: string;
  root: string;
  size: number;
  sha256: string;
  chunkBytes: number;
  chunks: number;
};

export type DownloadChunk = {
  transferId: string;
  index: number;
  bytes: number;
  contentBase64: string;
  done: boolean;
};

type ResolvedRoot = DaemonFilesystemRootConfig & { canonicalPath: string };
type ResolvedTarget = { root: ResolvedRoot; absolutePath: string; remotePath: string };
type AuthorizedHandle = { handle: FileHandle; info: Stats };
type Transfer = DownloadOpen & {
  handle: FileHandle;
  baseline: Stats;
  expiresAt: number;
  timer?: NodeJS.Timeout;
};
type MutationState = "pending" | "committed" | "not_committed" | "conflict" | "unknown";
export type MutationStatus = {
  operationId: string;
  state: MutationState;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
};
type MutationRecord = MutationStatus & { fingerprint: string; expiresAt: number };
type MutationParent = {
  root: ResolvedRoot;
  handle: FileHandle;
  name: string;
  remotePath: string;
  key: string;
};
type DestinationSnapshot = { info: Stats; sha256: string } | null;
type Upload = {
  operationId: string;
  fingerprint: string;
  parent: MutationParent;
  temporaryName: string;
  handle: FileHandle;
  size: number;
  sha256: string;
  expectedSha256?: string;
  baseline: DestinationSnapshot;
  chunks: number;
  nextIndex: number;
  received: number;
  hash: Hash;
  chunkHashes: string[];
  expiresAt: number;
  timer?: NodeJS.Timeout;
};


const BLOCKED_COMPONENTS = new Set([
  ".aws",
  ".config",
  ".docker",
  ".git",
  ".gnupg",
  ".grokbox",
  ".grokbox-trash",
  ".kube",
  ".password-store",
  ".ssh",
  "keychains",
  "keyrings",
  "sand-data",
]);
const BLOCKED_FILES = new Set([
  ".env",
  ".git-credentials",
  ".netrc",
  ".npmrc",
  ".pypirc",
  "credentials",
  "id_ed25519",
  "id_rsa",
]);
const BLOCKED_PREFIXES = [".bash", ".env", ".gitconfig", ".grokbox-", ".profile", ".sand-", ".tmux", ".zsh"];
const BLOCKED_SUFFIXES = [".key", ".p12", ".pem", ".pfx"];
const PSEUDO_ROOTS = ["/dev", "/proc", "/run", "/sys"];

function within(root: string, target: string): boolean {
  const value = relative(root, target);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

function blockedPath(path: string): boolean {
  const normalized = resolve(path);
  if (PSEUDO_ROOTS.some((root) => normalized === root || normalized.startsWith(`${root}${sep}`))) return true;
  const components = normalized.split(sep).filter(Boolean).map((value) => value.toLowerCase());
  const last = components.at(-1) ?? "";
  return components.some((value) => BLOCKED_COMPONENTS.has(value)) ||
    BLOCKED_FILES.has(last) || BLOCKED_PREFIXES.some((prefix) => last.startsWith(prefix)) ||
    BLOCKED_SUFFIXES.some((suffix) => last.endsWith(suffix));
}

function parseRemotePath(value: string): { rootName: string; parts: string[]; remotePath: string } {
  if (value.includes("\0") || value.includes("\\") || Buffer.byteLength(value) > 4096) {
    throw new CliError("fs_path_invalid", "Remote path is invalid.");
  }
  const match = /^([a-z][a-z0-9-]{0,31}):\/(.*)$/.exec(value);
  if (!match) throw new CliError("fs_path_invalid", "Remote path must use root:/relative/path syntax.");
  const rootName = match[1]!;
  const tail = match[2]!;
  const parts = tail === "" ? [] : tail.split("/");
  if (parts.some((part) => part === "" || part === "." || part === ".." || Buffer.byteLength(part) > 255)) {
    throw new CliError("fs_path_invalid", "Remote path contains an invalid segment.");
  }
  return { rootName, parts, remotePath: `${rootName}:/${parts.join("/")}` };
}

function mapFilesystemError(error: unknown): never {
  if (error instanceof CliError) throw error;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") throw new CliError("fs_not_found", "Remote path was not found.");
  if (code === "EACCES" || code === "EPERM" || code === "ELOOP") {
    throw new CliError("fs_forbidden", "Remote path is not authorized.");
  }
  throw new CliError("gateway_internal", "Filesystem operation failed.");
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function descriptorLink(handle: FileHandle): string {
  if (process.platform !== "linux") {
    throw new CliError("capability_unavailable", "Governed filesystem descriptor verification requires Linux.");
  }
  return `/proc/self/fd/${handle.fd}`;
}

async function verifyDescriptor(handle: FileHandle, root: ResolvedRoot): Promise<void> {
  let target: string;
  try {
    target = await realpath(descriptorLink(handle));
  } catch (error) {
    mapFilesystemError(error);
  }
  if (target.endsWith(" (deleted)") || !within(root.canonicalPath, target) || blockedPath(target)) {
    throw new CliError("fs_forbidden", "Opened filesystem object is outside the authorized root.");
  }
}

async function verifyExactDescriptor(handle: FileHandle, expectedPath: string): Promise<void> {
  let target: string;
  try {
    target = await realpath(descriptorLink(handle));
    const [opened, current] = await Promise.all([handle.stat(), stat(expectedPath)]);
    if (target !== expectedPath || opened.dev !== current.dev || opened.ino !== current.ino) {
      throw new CliError("fs_forbidden", "Internal filesystem object moved outside its reserved path.");
    }
  } catch (error) {
    mapFilesystemError(error);
  }
}

async function openAuthorized(root: ResolvedRoot, path: string): Promise<AuthorizedHandle> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    await verifyDescriptor(handle, root);
    const info = await handle.stat();
    if (!info.isFile() && !info.isDirectory()) {
      throw new CliError("fs_forbidden", "Remote path type is not authorized.");
    }
    return { handle, info };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    mapFilesystemError(error);
  }
}

async function sha256Handle(
  handle: FileHandle,
  sizeLimit: number,
  signal?: AbortSignal,
): Promise<string> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(FS_TRANSFER_CHUNK_BYTES);
  let offset = 0;
  while (true) {
    if (signal?.aborted) {
      throw new CliError("daemon_unreachable", "Filesystem operation was cancelled.", { retryable: true });
    }
    const result = await handle.read(buffer, 0, buffer.length, offset);
    if (signal?.aborted) {
      throw new CliError("daemon_unreachable", "Filesystem operation was cancelled.", { retryable: true });
    }
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
    if (offset > sizeLimit) throw new CliError("fs_too_large", "Remote file exceeds the operation byte limit.");
    hash.update(buffer.subarray(0, result.bytesRead));
  }
  return hash.digest("hex");
}

async function readBounded(handle: FileHandle, size: number, signal?: AbortSignal): Promise<Buffer> {
  if (size > FS_READ_MAX_BYTES) throw new CliError("fs_too_large", "Remote file exceeds the read byte limit.");
  const content = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    if (signal?.aborted) {
      throw new CliError("daemon_unreachable", "Filesystem operation was cancelled.", { retryable: true });
    }
    const result = await handle.read(content, offset, size - offset, offset);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  return content.subarray(0, offset);
}

async function assertDirectoryEmpty(directory: FileHandle): Promise<void> {
  const stream = await opendir(descriptorLink(directory));
  try {
    if (await stream.read()) throw new CliError("fs_not_empty", "Remote directory is not empty; use --recursive.");
  } finally {
    try {
      await stream.close();
    } catch {}
  }
}

async function validateRecursiveRemoval(
  root: ResolvedRoot,
  directory: FileHandle,
  depth = 0,
  counter = { value: 0 },
): Promise<void> {
  if (depth > REMOVE_MAX_DEPTH) throw new CliError("fs_forbidden", "Recursive remove exceeds the depth limit.");
  const stream = await opendir(descriptorLink(directory));
  try {
    for await (const entry of stream) {
      counter.value += 1;
      if (counter.value > REMOVE_MAX_ENTRIES || blockedPath(join(root.canonicalPath, entry.name))) {
        throw new CliError("fs_forbidden", "Recursive remove contains a blocked or excessive entry set.");
      }
      let child: AuthorizedHandle | undefined;
      try {
        child = await openAuthorized(root, join(descriptorLink(directory), entry.name));
        if (child.info.isDirectory()) await validateRecursiveRemoval(root, child.handle, depth + 1, counter);
      } finally {
        await child?.handle.close().catch(() => undefined);
      }
    }
  } finally {
    try {
      await stream.close();
    } catch {}
  }
}

function entryProjection(remotePath: string, name: string, info: Stats): FilesystemEntry {
  const kind = info.isFile() ? "file" : info.isDirectory() ? "directory" : null;
  if (!kind) throw new CliError("fs_forbidden", "Remote path type is not authorized.");
  return {
    name,
    path: remotePath,
    kind,
    size: info.size,
    mode: `0o${(info.mode & 0o777).toString(8).padStart(3, "0")}`,
    modifiedAt: info.mtime.toISOString(),
  };
}

type FilesystemLifecycleHooks = {
  beforeUploadPublish?: () => Promise<void>;
};

export class GovernedFilesystem {
  private readonly transfers = new Map<string, Transfer>();
  private readonly pendingTransfers = new Map<string, AbortController>();
  private readonly cancelledTransfers = new Map<string, number>();
  private cancelledSaturatedUntil = 0;
  private readonly mutations = new Map<string, MutationRecord>();
  private readonly uploads = new Map<string, Upload>();
  private readonly cancelledUploads = new Map<string, number>();
  private cancelledUploadsSaturatedUntil = 0;
  private readonly targetLocks = new Map<string, Promise<void>>();
  private readonly reservedTargets = new Map<string, string>();
  private uploadAdmission = Promise.resolve();
  private closing = false;

  private constructor(
    private readonly roots: ReadonlyMap<string, ResolvedRoot>,
    private readonly now: () => number,
    private readonly hooks: FilesystemLifecycleHooks,
  ) {}

  static async create(
    roots: readonly DaemonFilesystemRootConfig[],
    now: () => number,
    hooks: FilesystemLifecycleHooks = {},
  ): Promise<GovernedFilesystem> {
    const resolved = new Map<string, ResolvedRoot>();
    for (const root of roots) {
      try {
        const canonicalPath = await realpath(root.path);
        const info = await stat(canonicalPath);
        if (!info.isDirectory() || blockedPath(canonicalPath)) {
          throw new CliError("fs_forbidden", `Filesystem root '${root.name}' is not an authorized directory.`);
        }
        resolved.set(root.name, { ...root, canonicalPath });
      } catch (error) {
        mapFilesystemError(error);
      }
    }
    return new GovernedFilesystem(resolved, now, hooks);
  }

  projections(): FilesystemRootProjection[] {
    return [...this.roots.values()]
      .map((root) => ({ name: root.name, operations: [...root.operations] }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  private async closeTransfer(transferId: string): Promise<boolean> {
    const transfer = this.transfers.get(transferId);
    if (!transfer) return false;
    this.transfers.delete(transferId);
    if (transfer.timer) clearTimeout(transfer.timer);
    await transfer.handle.close().catch(() => undefined);
    return true;
  }

  private armTransfer(transfer: Transfer): void {
    if (transfer.timer) clearTimeout(transfer.timer);
    transfer.expiresAt = this.now() + TRANSFER_TTL_MS;
    transfer.timer = setTimeout(() => { void this.closeTransfer(transfer.transferId); }, TRANSFER_TTL_MS);
    transfer.timer.unref();
  }

  private async cleanupTransfers(): Promise<void> {
    const now = this.now();
    if (this.cancelledSaturatedUntil <= now) this.cancelledSaturatedUntil = 0;
    for (const [id, expiresAt] of this.cancelledTransfers) {
      if (expiresAt <= now) this.cancelledTransfers.delete(id);
    }
    for (const [id, transfer] of this.transfers) {
      if (transfer.expiresAt <= now) await this.closeTransfer(id);
    }
  }

  private cleanupMutations(): void {
    const now = this.now();
    for (const [id, record] of this.mutations) {
      if (record.expiresAt <= now && record.state !== "pending") this.mutations.delete(id);
    }
    while (this.mutations.size >= MUTATION_MAX) {
      const oldest = [...this.mutations.entries()].find(([, record]) => record.state !== "pending");
      if (!oldest) throw new CliError("fs_conflict", "Too many filesystem mutations are active.");
      this.mutations.delete(oldest[0]);
    }
  }

  private mutationFingerprint(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
  }

  private replayMutation(record: MutationRecord): Record<string, unknown> {
    if (record.state === "committed" && record.result) return record.result;
    if (record.state === "pending" || record.state === "unknown") {
      throw new CliError("operation_outcome_unknown", "Filesystem mutation outcome is not yet known.");
    }
    const error = record.error;
    throw new CliError(
      (error?.code ?? (record.state === "conflict" ? "fs_conflict" : "gateway_internal")) as ErrorCode,
      error?.message ?? "Filesystem mutation was not committed.",
    );
  }

  private async runMutation(
    operationId: string,
    fingerprint: string,
    action: () => Promise<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    if (!TRANSFER_ID_PATTERN.test(operationId)) throw new CliError("fs_conflict", "Filesystem operation identity is invalid.");
    const existing = this.mutations.get(operationId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new CliError("fs_conflict", "Filesystem operation identity was reused with different input.");
      return this.replayMutation(existing);
    }
    this.cleanupMutations();
    const record: MutationRecord = {
      operationId,
      fingerprint,
      state: "pending",
      expiresAt: this.now() + MUTATION_TTL_MS,
    };
    this.mutations.set(operationId, record);
    try {
      const result = await action();
      record.state = "committed";
      record.result = result;
      return result;
    } catch (error) {
      const mapped = error instanceof CliError
        ? error
        : new CliError("gateway_internal", "Filesystem mutation failed before commit.");
      record.state = mapped.code === "fs_conflict" || mapped.code === "fs_destination_exists"
        ? "conflict"
        : "not_committed";
      record.error = { code: mapped.code, message: mapped.message };
      throw mapped;
    }
  }

  private async withTargetLock<T>(key: string, operationId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.targetLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.targetLocks.set(key, current);
    await previous;
    try {
      const reserved = this.reservedTargets.get(key);
      if (reserved && reserved !== operationId) throw new CliError("fs_conflict", "Remote path has another active mutation.");
      return await action();
    } finally {
      release();
      if (this.targetLocks.get(key) === current) this.targetLocks.delete(key);
    }
  }

  private async withUploadAdmission<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.uploadAdmission;
    let release!: () => void;
    this.uploadAdmission = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  }

  private async mutationParent(value: string, operation: FilesystemOperation): Promise<MutationParent> {
    const parsed = parseRemotePath(value);
    const root = this.roots.get(parsed.rootName);
    if (!root || !root.operations.includes(operation) || parsed.parts.length === 0) {
      throw new CliError("fs_forbidden", "Remote path or operation is not authorized.");
    }
    const name = parsed.parts.at(-1)!;
    const lexical = join(root.canonicalPath, ...parsed.parts);
    if (!within(root.canonicalPath, lexical) || blockedPath(lexical)) {
      throw new CliError("fs_forbidden", "Remote path or operation is not authorized.");
    }
    const parentLexical = join(root.canonicalPath, ...parsed.parts.slice(0, -1));
    let parentCanonical: string;
    try {
      parentCanonical = await realpath(parentLexical);
    } catch (error) {
      return mapFilesystemError(error);
    }
    if (!within(root.canonicalPath, parentCanonical) || blockedPath(parentCanonical)) {
      throw new CliError("fs_forbidden", "Remote parent directory is not authorized.");
    }
    const opened = await openAuthorized(root, parentCanonical);
    if (!opened.info.isDirectory()) {
      await opened.handle.close();
      throw new CliError("fs_not_directory", "Remote parent path is not a directory.");
    }
    return {
      root,
      handle: opened.handle,
      name,
      remotePath: parsed.remotePath,
      key: `${opened.info.dev}:${opened.info.ino}:${name}`,
    };
  }

  private async destinationSnapshot(parent: MutationParent): Promise<DestinationSnapshot> {
    let opened: AuthorizedHandle | undefined;
    try {
      opened = await openAuthorized(parent.root, join(descriptorLink(parent.handle), parent.name));
      if (!opened.info.isFile()) throw new CliError("fs_not_file", "Existing remote destination is not a regular file.");
      return {
        info: opened.info,
        sha256: await sha256Handle(opened.handle, FS_UPLOAD_MAX_BYTES),
      };
    } catch (error) {
      if ((error as CliError).code === "fs_not_found") return null;
      throw error;
    } finally {
      await opened?.handle.close().catch(() => undefined);
    }
  }

  private async assertSnapshot(parent: MutationParent, baseline: DestinationSnapshot): Promise<void> {
    const current = await this.destinationSnapshot(parent);
    if (baseline === null && current === null) return;
    if (baseline === null || current === null || !sameFile(baseline.info, current.info) || baseline.sha256 !== current.sha256) {
      throw new CliError("fs_conflict", "Remote destination changed before commit.");
    }
  }

  mutationStatus(operationId: string): MutationStatus {
    const record = this.mutations.get(operationId);
    if (!record) return { operationId, state: "unknown" };
    return {
      operationId,
      state: record.state,
      ...(record.result ? { result: record.result } : {}),
      ...(record.error ? { error: record.error } : {}),
    };
  }

  private async target(value: string, operation: FilesystemOperation): Promise<ResolvedTarget> {
    const parsed = parseRemotePath(value);
    const root = this.roots.get(parsed.rootName);
    if (!root || !root.operations.includes(operation)) {
      throw new CliError("fs_forbidden", "Remote path or operation is not authorized.");
    }
    const lexical = join(root.canonicalPath, ...parsed.parts);
    if (!within(root.canonicalPath, lexical) || blockedPath(lexical)) {
      throw new CliError("fs_forbidden", "Remote path or operation is not authorized.");
    }
    try {
      const canonical = await realpath(lexical);
      if (!within(root.canonicalPath, canonical) || blockedPath(canonical)) {
        throw new CliError("fs_forbidden", "Remote path or operation is not authorized.");
      }
      return { root, absolutePath: canonical, remotePath: parsed.remotePath };
    } catch (error) {
      return mapFilesystemError(error);
    }
  }

  async executionDirectory(path: string, allowedRoots: readonly string[]): Promise<ExecutionDirectory> {
    const parsed = parseRemotePath(path);
    if (!allowedRoots.includes(parsed.rootName)) throw new CliError("fs_forbidden", "Process cwd root is not authorized.");
    const target = await this.target(path, "exec");
    const opened = await openAuthorized(target.root, target.absolutePath);
    if (!opened.info.isDirectory()) {
      await opened.handle.close();
      throw new CliError("fs_not_directory", "Process cwd is not a directory.");
    }
    return {
      remotePath: target.remotePath,
      descriptorPath: descriptorLink(opened.handle),
      verify: async () => await verifyDescriptor(opened.handle, target.root),
      close: async () => await opened.handle.close(),
    };
  }

  async stat(path: string, signal?: AbortSignal): Promise<FilesystemStat> {
    const target = await this.target(path, "stat");
    let opened: AuthorizedHandle | undefined;
    try {
      opened = await openAuthorized(target.root, target.absolutePath);
      const entry = entryProjection(
        target.remotePath,
        target.remotePath.split("/").at(-1) || target.root.name,
        opened.info,
      );
      const sha256 = entry.kind === "file" && opened.info.size <= FS_DOWNLOAD_MAX_BYTES
        ? await sha256Handle(opened.handle, FS_DOWNLOAD_MAX_BYTES, signal)
        : null;
      if (!sameFile(opened.info, await opened.handle.stat())) {
        throw new CliError("fs_transfer_invalid", "Remote file changed while being inspected.");
      }
      return { ...entry, root: target.root.name, sha256 };
    } catch (error) {
      return mapFilesystemError(error);
    } finally {
      await opened?.handle.close().catch(() => undefined);
    }
  }

  async list(path: string): Promise<{ path: string; root: string; entries: FilesystemEntry[] }> {
    const target = await this.target(path, "list");
    let parent: AuthorizedHandle | undefined;
    try {
      parent = await openAuthorized(target.root, target.absolutePath);
      if (!parent.info.isDirectory()) throw new CliError("fs_not_directory", "Remote path is not a directory.");
      const directory = await opendir(descriptorLink(parent.handle));
      const names: string[] = [];
      for await (const entry of directory) {
        names.push(entry.name);
        if (names.length > FS_LIST_MAX_ENTRIES) {
          throw new CliError("fs_too_large", "Remote directory exceeds the list entry limit.");
        }
      }
      names.sort();
      const entries: FilesystemEntry[] = [];
      for (const name of names) {
        const childPath = target.remotePath.endsWith("/")
          ? `${target.remotePath}${name}`
          : `${target.remotePath}/${name}`;
        if (blockedPath(join(target.root.canonicalPath, ...parseRemotePath(childPath).parts))) continue;
        let child: AuthorizedHandle | undefined;
        try {
          await verifyDescriptor(parent.handle, target.root);
          child = await openAuthorized(target.root, `${descriptorLink(parent.handle)}/${name}`);
          entries.push(entryProjection(childPath, name, child.info));
        } catch (error) {
          if (error instanceof CliError && (error.code === "fs_forbidden" || error.code === "fs_not_found")) continue;
          throw error;
        } finally {
          await child?.handle.close().catch(() => undefined);
        }
      }
      await verifyDescriptor(parent.handle, target.root);
      return { path: target.remotePath, root: target.root.name, entries };
    } catch (error) {
      return mapFilesystemError(error);
    } finally {
      await parent?.handle.close().catch(() => undefined);
    }
  }

  async read(path: string, signal?: AbortSignal): Promise<FilesystemRead> {
    const target = await this.target(path, "read");
    let opened: AuthorizedHandle | undefined;
    try {
      opened = await openAuthorized(target.root, target.absolutePath);
      if (!opened.info.isFile()) throw new CliError("fs_not_file", "Remote path is not a regular file.");
      const content = await readBounded(opened.handle, opened.info.size, signal);
      const after = await opened.handle.stat();
      if (content.length !== opened.info.size || !sameFile(opened.info, after)) {
        throw new CliError("fs_transfer_invalid", "Remote file changed while being read.");
      }
      const sha256 = createHash("sha256").update(content).digest("hex");
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
        if (!text.includes("\0")) {
          return {
            path: target.remotePath,
            root: target.root.name,
            size: content.length,
            sha256,
            encoding: "utf8",
            content: text,
          };
        }
      } catch {
        // Binary content is represented explicitly as base64.
      }
      return {
        path: target.remotePath,
        root: target.root.name,
        size: content.length,
        sha256,
        encoding: "base64",
        content: content.toString("base64"),
      };
    } catch (error) {
      return mapFilesystemError(error);
    } finally {
      await opened?.handle.close().catch(() => undefined);
    }
  }

  async write(
    operationId: string,
    path: string,
    content: Buffer,
    expectedSha256?: string,
  ): Promise<Record<string, unknown>> {
    if (content.length > FS_WRITE_MAX_BYTES) throw new CliError("fs_too_large", "Text write exceeds the 1 MiB limit.");
    if (expectedSha256 !== undefined && !/^[0-9a-f]{64}$/.test(expectedSha256)) {
      throw new CliError("fs_conflict", "Expected SHA-256 is invalid.");
    }
    const sha256 = createHash("sha256").update(content).digest("hex");
    const fingerprint = this.mutationFingerprint({ method: "write", path, sha256, expectedSha256 });
    return await this.runMutation(operationId, fingerprint, async () => {
      const parent = await this.mutationParent(path, "write");
      const temporaryName = `.grokbox-write-${operationId}.tmp`;
      const temporaryPath = join(descriptorLink(parent.handle), temporaryName);
      let temporary: FileHandle | undefined;
      let committed = false;
      try {
        return await this.withTargetLock(parent.key, operationId, async () => {
          const baseline = await this.destinationSnapshot(parent);
          if (expectedSha256 !== undefined && baseline?.sha256 !== expectedSha256) {
            throw new CliError("fs_conflict", "Remote destination does not match the expected SHA-256.");
          }
          temporary = await open(temporaryPath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          await temporary.writeFile(content);
          await temporary.sync();
          const temporaryInfo = await temporary.stat();
          const temporarySha256 = await sha256Handle(temporary, FS_WRITE_MAX_BYTES);
          if (temporaryInfo.size !== content.length || temporarySha256 !== sha256) {
            throw new CliError("fs_hash_mismatch", "Temporary text write failed size or SHA-256 verification.");
          }
          await verifyDescriptor(parent.handle, parent.root);
          await this.assertSnapshot(parent, baseline);
          await verifyDescriptor(parent.handle, parent.root);
          await temporary.close();
          temporary = undefined;
          await verifyDescriptor(parent.handle, parent.root);
          await rename(temporaryPath, join(descriptorLink(parent.handle), parent.name));
          committed = true;
          await parent.handle.sync().catch(() => undefined);
          return {
            operationId,
            state: "committed",
            path: parent.remotePath,
            size: content.length,
            sha256,
            replaced: baseline !== null,
          };
        });
      } finally {
        await temporary?.close().catch(() => undefined);
        if (!committed) await unlink(temporaryPath).catch(() => undefined);
        await parent.handle.close().catch(() => undefined);
      }
    });
  }

  async makeDirectory(operationId: string, path: string): Promise<Record<string, unknown>> {
    const fingerprint = this.mutationFingerprint({ method: "mkdir", path });
    return await this.runMutation(operationId, fingerprint, async () => {
      const parent = await this.mutationParent(path, "mkdir");
      try {
        return await this.withTargetLock(parent.key, operationId, async () => {
          await verifyDescriptor(parent.handle, parent.root);
          try {
            await mkdir(join(descriptorLink(parent.handle), parent.name), { mode: 0o700 });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST") {
              throw new CliError("fs_conflict", "Remote directory destination already exists.");
            }
            mapFilesystemError(error);
          }
          await parent.handle.sync().catch(() => undefined);
          return { operationId, state: "committed", path: parent.remotePath, kind: "directory" };
        });
      } finally {
        await parent.handle.close().catch(() => undefined);
      }
    });
  }

  private async trashDirectory(root: ResolvedRoot): Promise<FileHandle> {
    const rootHandle = await openAuthorized(root, root.canonicalPath);
    if (!rootHandle.info.isDirectory()) {
      await rootHandle.handle.close();
      throw new CliError("fs_forbidden", "Authorized filesystem root is not a directory.");
    }
    const path = join(descriptorLink(rootHandle.handle), TRASH_DIRECTORY);
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        await rootHandle.handle.close();
        mapFilesystemError(error);
      }
    }
    let trash: FileHandle | undefined;
    try {
      trash = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const info = await trash.stat();
      if (!info.isDirectory() || (typeof process.getuid === "function" && info.uid !== process.getuid())) {
        throw new CliError("fs_forbidden", "Filesystem trash directory ownership is invalid.");
      }
      await trash.chmod(0o700);
      const canonical = await realpath(descriptorLink(trash));
      if (!within(root.canonicalPath, canonical) || canonical !== join(root.canonicalPath, TRASH_DIRECTORY)) {
        throw new CliError("fs_forbidden", "Filesystem trash directory is not authorized.");
      }
      return trash;
    } catch (error) {
      await trash?.close().catch(() => undefined);
      mapFilesystemError(error);
    } finally {
      await rootHandle.handle.close().catch(() => undefined);
    }
  }

  async remove(
    operationId: string,
    path: string,
    recursive: boolean,
  ): Promise<Record<string, unknown>> {
    const fingerprint = this.mutationFingerprint({ method: "remove", path, recursive });
    return await this.runMutation(operationId, fingerprint, async () => {
      const parent = await this.mutationParent(path, recursive ? "remove-recursive" : "remove");
      let target: AuthorizedHandle | undefined;
      let currentTarget: AuthorizedHandle | undefined;
      let trash: FileHandle | undefined;
      let trashContainer: FileHandle | undefined;
      let trashReservationPath: string | undefined;
      let trashReservationCommitted = false;
      try {
        return await this.withTargetLock(parent.key, operationId, async () => {
          target = await openAuthorized(parent.root, join(descriptorLink(parent.handle), parent.name));
          const kind = target.info.isDirectory() ? "directory" : target.info.isFile() ? "file" : null;
          if (!kind) throw new CliError("fs_forbidden", "Remote path type cannot be removed.");
          if (kind === "directory" && recursive) {
            await validateRecursiveRemoval(parent.root, target.handle);
          }
          if (kind === "directory" && !recursive) {
            await assertDirectoryEmpty(target.handle);
          }
          trash = await this.trashDirectory(parent.root);
          const trashId = operationId;
          trashReservationPath = join(descriptorLink(trash), trashId);
          try {
            await mkdir(trashReservationPath, { mode: 0o700 });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST") {
              throw new CliError("fs_conflict", "Recoverable trash identity already exists.");
            }
            mapFilesystemError(error);
          }
          trashContainer = await open(
            trashReservationPath,
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
          );
          await trashContainer.chmod(0o700);
          const trashTarget = join(descriptorLink(trashContainer), parent.name);
          if (kind === "directory") {
            if (recursive) await validateRecursiveRemoval(parent.root, target.handle);
            else await assertDirectoryEmpty(target.handle);
          }
          currentTarget = await openAuthorized(parent.root, join(descriptorLink(parent.handle), parent.name));
          if (!sameFile(target.info, currentTarget.info)) {
            throw new CliError("fs_conflict", "Remote remove target changed before commit.");
          }
          await verifyExactDescriptor(trash, join(parent.root.canonicalPath, TRASH_DIRECTORY));
          await verifyExactDescriptor(
            trashContainer,
            join(parent.root.canonicalPath, TRASH_DIRECTORY, operationId),
          );
          await verifyDescriptor(parent.handle, parent.root);
          await rename(
            join(descriptorLink(parent.handle), parent.name),
            trashTarget,
          );
          trashReservationCommitted = true;
          await parent.handle.sync().catch(() => undefined);
          await trashContainer.sync().catch(() => undefined);
          await trash.sync().catch(() => undefined);
          return {
            operationId,
            state: "committed",
            path: parent.remotePath,
            kind,
            trashId,
            recoverable: true,
          };
        });
      } finally {
        await currentTarget?.handle.close().catch(() => undefined);
        await target?.handle.close().catch(() => undefined);
        await trashContainer?.close().catch(() => undefined);
        if (trashReservationPath && !trashReservationCommitted) {
          await rmdir(trashReservationPath).catch(() => undefined);
        }
        await trash?.close().catch(() => undefined);
        await parent.handle.close().catch(() => undefined);
      }
    });
  }

  private armUpload(upload: Upload): void {
    if (upload.timer) clearTimeout(upload.timer);
    upload.expiresAt = this.now() + TRANSFER_TTL_MS;
    upload.timer = setTimeout(() => { void this.cancelUpload(upload.operationId); }, TRANSFER_TTL_MS);
    upload.timer.unref();
  }

  async openUpload(
    operationId: string,
    path: string,
    size: number,
    sha256: string,
    expectedSha256?: string,
  ): Promise<Record<string, unknown>> {
    return await this.withUploadAdmission(async () => {
      if (this.closing) throw new CliError("daemon_unreachable", "Filesystem service is closing.", { retryable: true });
      return await this.openUploadAdmitted(operationId, path, size, sha256, expectedSha256);
    });
  }

  private async openUploadAdmitted(
    operationId: string,
    path: string,
    size: number,
    sha256: string,
    expectedSha256?: string,
  ): Promise<Record<string, unknown>> {
    if (!TRANSFER_ID_PATTERN.test(operationId) || !Number.isSafeInteger(size) || size < 0 ||
      size > FS_UPLOAD_MAX_BYTES || !/^[0-9a-f]{64}$/.test(sha256) ||
      (expectedSha256 !== undefined && !/^[0-9a-f]{64}$/.test(expectedSha256))) {
      throw new CliError("fs_upload_invalid", "Upload metadata is invalid.");
    }
    if (this.cancelledUploadsSaturatedUntil > this.now()) {
      throw new CliError("fs_upload_invalid", "Upload opening is temporarily blocked by cancellation reconciliation.");
    }
    const cancelledUntil = this.cancelledUploads.get(operationId);
    if (cancelledUntil !== undefined) {
      if (cancelledUntil > this.now()) throw new CliError("fs_upload_invalid", "Upload was cancelled before opening.");
      this.cancelledUploads.delete(operationId);
    }
    const fingerprint = this.mutationFingerprint({ method: "upload", path, size, sha256, expectedSha256 });
    const existing = this.mutations.get(operationId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new CliError("fs_conflict", "Upload identity was reused with different input.");
      const upload = this.uploads.get(operationId);
      if (upload) return {
        operationId,
        path: upload.parent.remotePath,
        size,
        sha256,
        chunkBytes: FS_TRANSFER_CHUNK_BYTES,
        chunks: upload.chunks,
      };
      return this.replayMutation(existing);
    }
    if (this.uploads.size >= UPLOAD_MAX) throw new CliError("fs_conflict", "Too many uploads are active.");
    this.cleanupMutations();
    const parent = await this.mutationParent(path, "upload");
    const temporaryName = `.grokbox-upload-${operationId}.tmp`;
    let handle: FileHandle | undefined;
    let createdTemporary = false;
    try {
      return await this.withTargetLock(parent.key, operationId, async () => {
        const current = this.mutations.get(operationId);
        if (current) {
          if (current.fingerprint !== fingerprint) {
            throw new CliError("fs_conflict", "Upload identity was reused with different input.");
          }
          const active = this.uploads.get(operationId);
          if (active) {
            await parent.handle.close().catch(() => undefined);
            return {
              operationId,
              path: active.parent.remotePath,
              size,
              sha256,
              chunkBytes: FS_TRANSFER_CHUNK_BYTES,
              chunks: active.chunks,
            };
          }
          await parent.handle.close().catch(() => undefined);
          return this.replayMutation(current);
        }
        if (this.reservedTargets.has(parent.key)) throw new CliError("fs_conflict", "Remote destination has another active upload.");
        const baseline = await this.destinationSnapshot(parent);
        if ((this.cancelledUploads.get(operationId) ?? 0) > this.now()) {
          throw new CliError("fs_upload_invalid", "Upload was cancelled while opening.");
        }
        if (expectedSha256 !== undefined && baseline?.sha256 !== expectedSha256) {
          throw new CliError("fs_conflict", "Remote destination does not match the expected SHA-256.");
        }
        handle = await open(
          join(descriptorLink(parent.handle), temporaryName),
          constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        createdTemporary = true;
        if ((this.cancelledUploads.get(operationId) ?? 0) > this.now()) {
          throw new CliError("fs_upload_invalid", "Upload was cancelled while opening.");
        }
        await verifyDescriptor(parent.handle, parent.root);
        if (this.hooks.beforeUploadPublish) await this.hooks.beforeUploadPublish();
        if (this.closing) {
          throw new CliError("daemon_unreachable", "Filesystem service is closing.", { retryable: true });
        }
        if ((this.cancelledUploads.get(operationId) ?? 0) > this.now()) {
          throw new CliError("fs_upload_invalid", "Upload was cancelled while opening.");
        }
        const chunks = Math.ceil(size / FS_TRANSFER_CHUNK_BYTES);
        const upload: Upload = {
          operationId,
          fingerprint,
          parent,
          temporaryName,
          handle,
          size,
          sha256,
          ...(expectedSha256 ? { expectedSha256 } : {}),
          baseline,
          chunks,
          nextIndex: 0,
          received: 0,
          hash: createHash("sha256"),
          chunkHashes: [],
          expiresAt: this.now() + TRANSFER_TTL_MS,
        };
        handle = undefined;
        this.uploads.set(operationId, upload);
        this.reservedTargets.set(parent.key, operationId);
        this.mutations.set(operationId, {
          operationId,
          fingerprint,
          state: "pending",
          expiresAt: this.now() + MUTATION_TTL_MS,
        });
        this.armUpload(upload);
        return { operationId, path: parent.remotePath, size, sha256, chunkBytes: FS_TRANSFER_CHUNK_BYTES, chunks };
      });
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (createdTemporary) {
        await unlink(join(descriptorLink(parent.handle), temporaryName)).catch(() => undefined);
      }
      await parent.handle.close().catch(() => undefined);
      throw error;
    }
  }

  async uploadChunk(operationId: string, index: number, content: Buffer): Promise<Record<string, unknown>> {
    const initial = this.uploads.get(operationId);
    if (!initial) throw new CliError("fs_upload_invalid", "Upload transfer or chunk is invalid.");
    return await this.withTargetLock(initial.parent.key, operationId, async () => {
      const upload = this.uploads.get(operationId);
      if (!upload || !Number.isSafeInteger(index) || index < 0 || index >= upload.chunks) {
        throw new CliError("fs_upload_invalid", "Upload transfer or chunk is invalid.");
      }
      await verifyDescriptor(upload.parent.handle, upload.parent.root);
      const expected = Math.min(FS_TRANSFER_CHUNK_BYTES, upload.size - index * FS_TRANSFER_CHUNK_BYTES);
      if (content.length !== expected) throw new CliError("fs_upload_invalid", "Upload chunk length is invalid.");
      const digest = createHash("sha256").update(content).digest("hex");
      if (index < upload.nextIndex) {
        if (upload.chunkHashes[index] !== digest) throw new CliError("fs_upload_invalid", "Repeated upload chunk differs from accepted bytes.");
        return { operationId, index, bytes: content.length, accepted: true, repeated: true };
      }
      if (index !== upload.nextIndex) throw new CliError("fs_upload_invalid", "Upload chunks must be sent in order.");
      let written = 0;
      while (written < content.length) {
        const result = await upload.handle.write(content, written, content.length - written, upload.received + written);
        if (result.bytesWritten === 0) throw new CliError("gateway_internal", "Upload chunk could not be fully written.");
        written += result.bytesWritten;
      }
      upload.hash.update(content);
      upload.chunkHashes.push(digest);
      upload.received += content.length;
      upload.nextIndex += 1;
      this.armUpload(upload);
      return { operationId, index, bytes: content.length, accepted: true, repeated: false };
    });
  }

  async commitUpload(operationId: string): Promise<Record<string, unknown>> {
    const initial = this.uploads.get(operationId);
    if (!initial) {
      const record = this.mutations.get(operationId);
      if (record) return this.replayMutation(record);
      throw new CliError("operation_outcome_unknown", "Upload outcome is unknown.");
    }
    return await this.withTargetLock(initial.parent.key, operationId, async () => {
      const upload = this.uploads.get(operationId);
      const record = this.mutations.get(operationId);
      if (!upload) {
        if (record) return this.replayMutation(record);
        throw new CliError("operation_outcome_unknown", "Upload outcome is unknown.");
      }
      if (!record || record.fingerprint !== upload.fingerprint) {
        throw new CliError("fs_conflict", "Upload mutation ledger is inconsistent.");
      }
      try {
        if (upload.received !== upload.size || upload.nextIndex !== upload.chunks) {
          throw new CliError("fs_upload_invalid", "Upload is incomplete.");
        }
        const rolling = upload.hash.digest("hex");
        const temporaryInfo = await upload.handle.stat();
        const actual = await sha256Handle(upload.handle, FS_UPLOAD_MAX_BYTES);
        if (temporaryInfo.size !== upload.size || rolling !== upload.sha256 || actual !== upload.sha256) {
          throw new CliError("fs_hash_mismatch", "Uploaded temporary file failed size or SHA-256 verification.");
        }
        await upload.handle.sync();
        await verifyDescriptor(upload.parent.handle, upload.parent.root);
        await this.assertSnapshot(upload.parent, upload.baseline);
        await verifyDescriptor(upload.parent.handle, upload.parent.root);
        await upload.handle.close();
        await verifyDescriptor(upload.parent.handle, upload.parent.root);
        await rename(
          join(descriptorLink(upload.parent.handle), upload.temporaryName),
          join(descriptorLink(upload.parent.handle), upload.parent.name),
        );
        const result = {
          operationId,
          state: "committed",
          path: upload.parent.remotePath,
          size: upload.size,
          sha256: upload.sha256,
          replaced: upload.baseline !== null,
        };
        record.state = "committed";
        record.result = result;
        this.uploads.delete(operationId);
        this.reservedTargets.delete(upload.parent.key);
        if (upload.timer) clearTimeout(upload.timer);
        await upload.parent.handle.sync().catch(() => undefined);
        await upload.parent.handle.close().catch(() => undefined);
        return result;
      } catch (error) {
        const mapped = error instanceof CliError ? error : new CliError("gateway_internal", "Upload commit failed.");
        record.state = mapped.code === "fs_conflict" ? "conflict" : "not_committed";
        record.error = { code: mapped.code, message: mapped.message };
        await this.cancelUpload(operationId, true, true);
        throw mapped;
      }
    });
  }

  async cancelUpload(
    operationId: string,
    preserveOutcome = false,
    alreadyLocked = false,
  ): Promise<{ operationId: string; cancelled: boolean }> {
    const now = this.now();
    if (this.cancelledUploadsSaturatedUntil <= now) this.cancelledUploadsSaturatedUntil = 0;
    for (const [id, expiresAt] of this.cancelledUploads) {
      if (expiresAt <= now) this.cancelledUploads.delete(id);
    }
    const initial = this.uploads.get(operationId);
    if (initial && !alreadyLocked) {
      return await this.withTargetLock(
        initial.parent.key,
        operationId,
        async () => await this.cancelUpload(operationId, preserveOutcome, true),
      );
    }
    const upload = this.uploads.get(operationId);
    if (!upload) {
      if (this.mutations.has(operationId)) return { operationId, cancelled: false };
      if (TRANSFER_ID_PATTERN.test(operationId)) {
        if (this.cancelledUploads.size >= CANCELLED_TRANSFER_MAX) {
          this.cancelledUploadsSaturatedUntil = Math.max(
            this.cancelledUploadsSaturatedUntil,
            this.now() + TRANSFER_TTL_MS,
          );
        } else {
          this.cancelledUploads.set(operationId, this.now() + TRANSFER_TTL_MS);
        }
      }
      return { operationId, cancelled: false };
    }
    this.uploads.delete(operationId);
    this.reservedTargets.delete(upload.parent.key);
    if (upload.timer) clearTimeout(upload.timer);
    await upload.handle.close().catch(() => undefined);
    await unlink(join(descriptorLink(upload.parent.handle), upload.temporaryName)).catch(() => undefined);
    await upload.parent.handle.close().catch(() => undefined);
    if (!preserveOutcome) {
      const record = this.mutations.get(operationId);
      if (record?.state === "pending") {
        record.state = "not_committed";
        record.error = { code: "fs_upload_invalid", message: "Upload was cancelled before commit." };
      }
    }
    return { operationId, cancelled: true };
  }

  async openDownload(
    path: string,
    transferId: string,
    signal?: AbortSignal,
  ): Promise<DownloadOpen> {
    if (this.closing) {
      throw new CliError("daemon_unreachable", "Filesystem service is closing.", { retryable: true });
    }
    const validId = TRANSFER_ID_PATTERN.test(transferId);
    const cancelledUntil = this.cancelledTransfers.get(transferId);
    if (cancelledUntil !== undefined && cancelledUntil <= this.now()) {
      this.cancelledTransfers.delete(transferId);
    }
    if (!validId || this.transfers.has(transferId) || this.pendingTransfers.has(transferId) ||
      (this.cancelledTransfers.get(transferId) ?? 0) > this.now() ||
      this.cancelledSaturatedUntil > this.now()) {
      throw new CliError("fs_transfer_invalid", "Download transfer identity is invalid, cancelled, or already active.");
    }

    const controller = new AbortController();
    this.pendingTransfers.set(transferId, controller);
    const operationSignal = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    let opened: AuthorizedHandle | undefined;
    try {
      await this.cleanupTransfers();
      if (operationSignal.aborted) throw new CliError("fs_transfer_invalid", "Download transfer was cancelled while opening.");
      const target = await this.target(path, "download");
      if (operationSignal.aborted) throw new CliError("fs_transfer_invalid", "Download transfer was cancelled while opening.");
      opened = await openAuthorized(target.root, target.absolutePath);
      if (operationSignal.aborted) throw new CliError("fs_transfer_invalid", "Download transfer was cancelled while opening.");
      if (!opened.info.isFile()) throw new CliError("fs_not_file", "Remote path is not a regular file.");
      if (opened.info.size > FS_DOWNLOAD_MAX_BYTES) {
        throw new CliError("fs_too_large", "Remote file exceeds the download byte limit.");
      }
      const sha256 = await sha256Handle(opened.handle, FS_DOWNLOAD_MAX_BYTES, operationSignal);
      const afterHash = await opened.handle.stat();
      if (operationSignal.aborted) throw new CliError("fs_transfer_invalid", "Download transfer was cancelled while opening.");
      if (!sameFile(opened.info, afterHash)) {
        throw new CliError("fs_transfer_invalid", "Remote file changed while opening the download.");
      }
      if (this.closing || operationSignal.aborted) {
        throw new CliError("fs_transfer_invalid", "Download transfer was cancelled while opening.");
      }
      const result: DownloadOpen = {
        transferId,
        path: target.remotePath,
        root: target.root.name,
        size: opened.info.size,
        sha256,
        chunkBytes: FS_TRANSFER_CHUNK_BYTES,
        chunks: Math.ceil(opened.info.size / FS_TRANSFER_CHUNK_BYTES),
      };
      const transfer: Transfer = {
        ...result,
        handle: opened.handle,
        baseline: opened.info,
        expiresAt: this.now() + TRANSFER_TTL_MS,
      };
      opened = undefined;
      this.transfers.set(transferId, transfer);
      this.armTransfer(transfer);
      return result;
    } catch (error) {
      if (controller.signal.aborted) {
        return mapFilesystemError(new CliError("fs_transfer_invalid", "Download transfer was cancelled while opening."));
      }
      return mapFilesystemError(error);
    } finally {
      this.pendingTransfers.delete(transferId);
      await opened?.handle.close().catch(() => undefined);
    }
  }

  async downloadChunk(transferId: string, index: number): Promise<DownloadChunk> {
    await this.cleanupTransfers();
    const transfer = this.transfers.get(transferId);
    if (!transfer || !Number.isInteger(index) || index < 0 || index >= transfer.chunks) {
      throw new CliError("fs_transfer_invalid", "Download transfer or chunk is invalid.");
    }
    try {
      this.armTransfer(transfer);
      const before = await transfer.handle.stat();
      if (!sameFile(transfer.baseline, before)) {
        await this.closeTransfer(transferId);
        throw new CliError("fs_transfer_invalid", "Remote file changed during download.");
      }
      const offset = index * transfer.chunkBytes;
      const length = Math.min(transfer.chunkBytes, transfer.size - offset);
      const content = Buffer.alloc(length);
      let bytesRead = 0;
      while (bytesRead < length) {
        const result = await transfer.handle.read(content, bytesRead, length - bytesRead, offset + bytesRead);
        if (result.bytesRead === 0) break;
        bytesRead += result.bytesRead;
      }
      const after = await transfer.handle.stat();
      if (bytesRead !== length || !sameFile(transfer.baseline, after)) {
        await this.closeTransfer(transferId);
        throw new CliError("fs_transfer_invalid", "Remote file changed during download.");
      }
      return {
        transferId,
        index,
        bytes: bytesRead,
        contentBase64: content.toString("base64"),
        done: index === transfer.chunks - 1,
      };
    } catch (error) {
      return mapFilesystemError(error);
    }
  }

  async cancelDownload(transferId: string): Promise<{ transferId: string; cancelled: boolean }> {
    if (!TRANSFER_ID_PATTERN.test(transferId)) return { transferId, cancelled: false };
    const now = this.now();
    for (const [id, expiresAt] of this.cancelledTransfers) {
      if (expiresAt <= now) this.cancelledTransfers.delete(id);
    }
    if (this.cancelledTransfers.size >= CANCELLED_TRANSFER_MAX) {
      this.cancelledSaturatedUntil = Math.max(this.cancelledSaturatedUntil, now + TRANSFER_TTL_MS);
    } else {
      this.cancelledTransfers.set(transferId, now + TRANSFER_TTL_MS);
    }
    const pending = this.pendingTransfers.get(transferId);
    pending?.abort();
    const active = await this.closeTransfer(transferId);
    return { transferId, cancelled: Boolean(pending) || active };
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const controller of this.pendingTransfers.values()) controller.abort();
    this.pendingTransfers.clear();
    await this.withUploadAdmission(async () => undefined);
    this.cancelledTransfers.clear();
    this.cancelledUploads.clear();
    this.cancelledUploadsSaturatedUntil = 0;
    this.cancelledSaturatedUntil = 0;
    await Promise.all([...this.uploads.keys()].map(async (id) => await this.cancelUpload(id)));
    await Promise.all([...this.transfers.keys()].map(async (id) => await this.closeTransfer(id)));
  }
}
