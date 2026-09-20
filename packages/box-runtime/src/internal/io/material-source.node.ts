import { constants } from "node:fs";
import { open, opendir, realpath, rename, unlink, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { canonicalJson, sha256Text, sha256Bytes } from "@grokbox/runtime-kernel/hash";
import { MATERIAL_POLICY as P, materialPath, materialReference, MaterialError, type MaterialSourceConfig, type MaterialMetadata } from "@grokbox/runtime-kernel/materials";
export type BoundMaterialSource = { config: MaterialSourceConfig; root: string; rootDevice: number; rootInode: number; binding: string; installationId: string };
export type SourceDocument = { metadata: MaterialMetadata; content: string };
const fail = (code: ConstructorParameters<typeof MaterialError>[0], message: string): never => { throw new MaterialError(code, message); };
const absent = (e: unknown) => !!e && typeof e === "object" && "code" in e && e.code === "ENOENT";
const within = (root: string, path: string) => { const r = relative(root, path); return r === "" || r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r); };
const excluded = (path: string) => path.split("/").some(p => p.startsWith(".") || ["node_modules", "dist", "keychains", "keyrings", "sand-data", "agent-data"].includes(p.toLowerCase()))
  || /(?:^|\/)(?:credentials|id_rsa|id_ed25519)$|\.(?:key|pem|pfx|p12)$/i.test(path);
const textFile = (path: string) => /^(?:\.md|\.txt|\.json|\.ts|\.tsx|\.js|\.jsx|\.css|\.html|\.yaml|\.yml|\.toml|\.sql|\.py|\.go|\.rs|\.log|\.csv|\.xml|\.sh)$/.test(extname(path).toLowerCase());
const fdPath = (handle: FileHandle) => `/proc/self/fd/${handle.fd}`;
async function verify(handle: FileHandle, expected: string) {
  if (await realpath(fdPath(handle)) !== expected) return fail("source_changed", "The source path changed while it was being read.");
}
/** Bind configured roots and the caller-declared account scope, not a guessed
 * current account. Local replicas never imply upstream synchronization. */
export async function bindMaterialSource(config: MaterialSourceConfig, installationId: string, storeRoot: string): Promise<BoundMaterialSource> {
  if (process.platform !== "linux" || !isAbsolute(config.root)) return fail("source_unavailable", "This source requires a Linux descriptor-backed local root.");
  const root = await realpath(config.root).catch(() => fail("source_unavailable", "The configured source root is unavailable."));
  if (["/", "/home", "/workspace", "/tmp"].includes(root) || ["/dev", "/proc", "/sys", "/run"].some(p => within(p, root))
    || within(root, resolve(storeRoot)) || within(resolve(storeRoot), root)) return fail("permission_denied", "A material source cannot include system or management storage.");
  if (config.kind === "files" && root.split(sep).some(part => ["sand-data","agent-data",".ssh",".aws",".gnupg",".grokbox",".git","keychains","keyrings"].includes(part.toLowerCase()))) return fail("permission_denied", "This file root includes a protected native or credential location.");
  const handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await verify(handle, root); const info = await handle.stat();
    return { config: structuredClone(config), root, rootDevice: info.dev, rootInode: info.ino, installationId,
      binding: sha256Text(canonicalJson(["materials-source-v1", installationId, config, root, info.dev, info.ino])) };
  } finally { await handle.close(); }
}
async function parentFor(source: BoundMaterialSource, path: string) {
  const parts = materialPath(path).split("/"), name = parts.pop()!;
  let expected = source.root, handle = await open(expected, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await verify(handle, expected);
    const info = await handle.stat();
    if (info.dev !== source.rootDevice || info.ino !== source.rootInode) return fail("source_changed", "The source root identity changed.");
    for (const part of parts) {
      const next = await open(join(fdPath(handle), part), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await handle.close(); handle = next; expected = join(expected, part); await verify(handle, expected);
    }
    return { handle, name, expected, close: () => handle.close() };
  } catch (error) { await handle.close(); throw error; }
}
export function materialShape(source: BoundMaterialSource, path: string): Pick<MaterialMetadata, "kind" | "scope" | "agentId" | "project"> | null {
  const c = source.config; materialPath(path);
  if (c.kind === "files") return !excluded(path) && textFile(path) ? { kind: "file", scope: "file", agentId: null, project: null } : null;
  const p = path.split("/");
  const shardFile = (parts: string[]) => parts.length === 1 && parts[0] === "profile.md" || parts.length === 2 && parts[0] === "log" && /^[a-zA-Z0-9_-]+\.md$/.test(parts[1]!);
  if (p[0] === "agents" && c.agentIds.includes(p[1]!)) {
    if (p.length === 3 && p[2] === "projects.json") return { kind: "membership", scope: "agent", agentId: p[1]!, project: null };
    if (p[2] === "memory" && shardFile(p.slice(3))) return { kind: "memory", scope: "agent", agentId: p[1]!, project: null };
  }
  if (p[0] === "user-memory" && p[1] === "by-agent" && c.agentIds.includes(p[2]!) && shardFile(p.slice(3))) return { kind: "memory", scope: "user", agentId: p[2]!, project: null };
  if (p[0] === "projects" && c.projects.includes(p[1]!)) {
    if (p.length === 3 && p[2] === "project.md") return { kind: "project", scope: "project", agentId: null, project: p[1]! };
    if (p[2] === "memory" && p[3] === "by-agent" && c.agentIds.includes(p[4]!) && shardFile(p.slice(5))) return { kind: "memory", scope: "project", agentId: p[4]!, project: p[1]! };
  }
  return null;
}
async function readAt(source: BoundMaterialSource, parent: Awaited<ReturnType<typeof parentFor>>, path: string, signal: AbortSignal): Promise<SourceDocument> {
  const shape = materialShape(source, path); if (!shape) return fail("permission_denied", "This document is outside the configured material scope.");
  signal.throwIfAborted(); await verify(parent.handle, parent.expected);
  const file = await open(join(fdPath(parent.handle), parent.name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    await verify(file, join(parent.expected, parent.name)); const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1) return fail("permission_denied", "Only regular, unaliased material files are supported.");
    if (before.size > P.maxDocumentBytes) return fail("source_incomplete", "The document exceeds the configured read bound.");
    const bytes = Buffer.alloc(P.maxDocumentBytes + 1); let size = 0;
    while (size < bytes.length) { signal.throwIfAborted(); const got = await file.read(bytes, size, bytes.length - size, size); if (!got.bytesRead) break; size += got.bytesRead; }
    const after = await file.stat(); await verify(file, join(parent.expected, parent.name)); await verify(parent.handle, parent.expected); signal.throwIfAborted();
    if (size !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return fail("source_changed", "The document changed during its read.");
    let content: string; try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)); } catch { return fail("source_incomplete", "This material is not strict UTF-8 text."); }
    if (content.includes("\0")) return fail("source_incomplete", "This material is not a text document.");
    let membership: string[] = [];
    if (shape.kind === "membership") {
      let parsed: unknown; try { parsed = JSON.parse(content); } catch { return fail("source_incomplete", "The membership source is not valid JSON."); }
      const projects = (parsed as { projects?: unknown } | null)?.projects;
      if (!Array.isArray(projects) || projects.length > 256 || projects.some(v => typeof v !== "string")) return fail("source_incomplete", "The membership source has an unsupported shape.");
      membership = [...new Set(projects)].filter(slug => source.config.kind === "native-memory" && source.config.projects.includes(slug)).sort();
      // Do not persist or return memberships outside the configured Project scope.
      content = JSON.stringify({ projects: membership });
    }
    return { metadata: { ref: materialReference(source.installationId, source.binding, source.config.id, path), sourceId: source.config.id,
      binding: source.binding, path, ...shape, bytes: size, revision: sha256Bytes(bytes.subarray(0, size)), modifiedAtMs: Math.floor(before.mtimeMs),
      writable: source.config.kind === "files" && source.config.writable, membership, contentIncluded: false, author: "not-observed" }, content };
  } finally { await file.close(); }
}
export async function readMaterialSource(source: BoundMaterialSource, path: string, signal: AbortSignal): Promise<SourceDocument> {
  if (!materialShape(source,path)) return fail("permission_denied", "This document is outside the configured material scope.");
  let parent: Awaited<ReturnType<typeof parentFor>> | undefined;
  try { parent = await parentFor(source, path); return await readAt(source, parent, path, signal); }
  catch (error) { if (error instanceof MaterialError) throw error; return fail(absent(error) ? "not_found" : "source_unavailable", "The source document cannot be read safely."); }
  finally { await parent?.close(); }
}
export async function scanMaterialSource(source: BoundMaterialSource, signal: AbortSignal): Promise<{ documents: SourceDocument[]; skipped: number }> {
  const documents: SourceDocument[] = []; let skipped = 0, entries = 0, bytes = 0, full = false;
  const deadline = performance.now() + P.scanTimeoutMs;
  const check = () => { signal.throwIfAborted(); if (performance.now() > deadline) return fail("source_unavailable", "The bounded material scan deadline elapsed."); };
  const take = async (path: string) => {
    check(); if (full) return;
    try {
      const value = await readMaterialSource(source, path, signal);
      if (documents.length >= P.maxDocuments || bytes + value.metadata.bytes > P.maxSourceBytes) { skipped++; full = true; return; }
      documents.push(value); bytes += value.metadata.bytes;
    } catch (error) { if (signal.aborted) throw error; if (error instanceof MaterialError) skipped++; else throw error; }
  };
  const walk = async (directory: string, depth: number): Promise<void> => {
    check(); if (full) return;
    if (depth > P.maxDepth) { skipped++; return; }
    let parent: Awaited<ReturnType<typeof parentFor>> | undefined;
    try {
      parent = await parentFor(source, directory ? `${directory}/_` : "_");
      const dir = await opendir(fdPath(parent.handle));
      for await (const item of dir) {
        check(); if (++entries > P.maxDirectoryEntries || full) { skipped++; full = true; break; }
        const path = directory ? `${directory}/${item.name}` : item.name;
        if (source.config.kind === "files" && excluded(path)) continue;
        if (item.isDirectory()) { if (source.config.kind === "files" || item.name === "log") await walk(path, depth + 1); }
        else if (materialShape(source, path)) { if (item.isFile()) await take(path); else skipped++; }
      }
      await verify(parent.handle, parent.expected);
    } catch (error) { if (signal.aborted) throw error; if (absent(error)) skipped++; else throw error; }
    finally { await parent?.close(); }
  };
  if (source.config.kind === "files") await walk("", 0);
  else {
    for (const id of source.config.agentIds) {
      await walk(`agents/${id}/memory`, 0); await walk(`user-memory/by-agent/${id}`, 0); await take(`agents/${id}/projects.json`);
    }
    for (const slug of source.config.projects) {
      await take(`projects/${slug}/project.md`);
      for (const id of source.config.agentIds) await walk(`projects/${slug}/memory/by-agent/${id}`, 0);
    }
  }
  check(); return { documents, skipped };
}
export type MaterialWriteHooks = { beforePublish?: () => Promise<void>; afterPublish?: () => Promise<void> };
/** One exact text replacement through a pinned parent. Cooperating callers are
 * fenced by the domain store. External writers do not acquire a fictitious CAS. */
export async function replaceMaterialSource(source: BoundMaterialSource, path: string, expectedRevision: string, content: string, signal: AbortSignal, hooks: MaterialWriteHooks = {}): Promise<SourceDocument> {
  if (source.config.kind !== "files" || !source.config.writable || !materialShape(source, path)) return fail("permission_denied", "Native material replicas and unapproved file sources are read-only.");
  let parent: Awaited<ReturnType<typeof parentFor>> | undefined, temp: FileHandle | undefined, tempPath: string | undefined, published = false, enteringPublication = false;
  try {
    parent = await parentFor(source, path); const before = await readAt(source, parent, path, signal);
    if (before.metadata.revision !== expectedRevision) return fail("revision_conflict", "The source changed; read it again without discarding the draft.");
    const original = await open(join(fdPath(parent.handle), parent.name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let mode: number; try { const info = await original.stat(); if (process.getuid && info.uid !== process.getuid()) return fail("permission_denied", "The source file is owned by another local identity."); mode = info.mode & 0o777; } finally { await original.close(); }
    tempPath = join(fdPath(parent.handle), `.grokbox-material-${randomUUID()}.tmp`);
    temp = await open(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    await temp.chmod(mode); await temp.writeFile(content, "utf8"); await temp.sync(); await hooks.beforePublish?.();
    const current = await readAt(source, parent, path, signal);
    if (current.metadata.revision !== expectedRevision) return fail("revision_conflict", "An external writer changed the source before publication.");
    signal.throwIfAborted(); await verify(parent.handle, parent.expected);
    enteringPublication = true; await rename(tempPath, join(fdPath(parent.handle), parent.name)); published = true;
    await parent.handle.sync(); await hooks.afterPublish?.();
    const after = await readAt(source, parent, path, new AbortController().signal);
    if (after.metadata.revision !== sha256Text(content)) return fail("operation_unknown", "The source publication could not be verified.");
    return after;
  } catch (error) {
    if (enteringPublication) return fail("operation_unknown", "The source write may have published. Query the original operation without repeating it.");
    if (error instanceof MaterialError) throw error;
    return fail("source_unavailable", "The source could not be replaced; no publication was verified.");
  } finally {
    if (tempPath && temp && !published) await unlink(tempPath).catch(() => undefined);
    await temp?.close(); await parent?.close();
  }
}
