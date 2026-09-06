import { chmod, mkdir, readdir, readFile, realpath, stat, writeFile, lstat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { findRosterRow } from "./commands/roster.ts";
import { CliError, usage } from "./errors.ts";
import { DEFAULT_AGENT_DATA_ROOT } from "./registry.ts";
import { asString, isRecord } from "./util.ts";

export { DEFAULT_AGENT_DATA_ROOT };

const MEMORY_LOG_FILE = /^\d{4}-\d{2}\.md$/;
const WORKFLOW_REF = /sand-workflow:([A-Za-z0-9][A-Za-z0-9._-]{1,127})/g;
const SECRET_KEY = /(token|secret|password|cookie|authorization|credential|api[_-]?key)/i;
const BLOCKED_COMPONENTS = new Set([
  ".aws",
  ".config",
  ".docker",
  ".git",
  ".gnupg",
  ".grokbox",
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
  "conversation-blobs.db",
  "conversation-blobs.db-shm",
  "conversation-blobs.db-wal",
  "credentials",
  "gateway.json",
  "id_ed25519",
  "id_rsa",
  "store.db",
  "store.db-shm",
  "store.db-wal",
]);
const BLOCKED_PREFIXES = [".bash", ".env", ".gitconfig", ".grokbox-", ".profile", ".sand-", ".tmux", ".zsh"];
const BLOCKED_SUFFIXES = [".key", ".p12", ".pem", ".pfx"];
const OMITTED_TRANSCRIPT_FILES = [
  "store.db",
  "store.db-shm",
  "store.db-wal",
  "conversation-blobs.db",
  "conversation-blobs.db-shm",
  "conversation-blobs.db-wal",
] as const;

export type Classification = "owned" | "related" | "unassociated";
export type MemoryLayer = "agent" | "user" | "project";

export type ExportPathRecord = {
  exportPath: string;
  sourcePath: string;
  classification: Classification;
  memoryLayer?: MemoryLayer;
  note?: string;
  redactedKeys?: string[];
};

export type RelatedReference = {
  kind: "workflow" | "skill" | "plugin";
  name: string;
  classification: "related";
  association: "reference";
  foundIn: string[];
  present: boolean;
  note: string;
};

export type AssociationNone = {
  association: "none";
  note: string;
};

export type AgentExportManifest = {
  agentId: string;
  name: string;
  kind: "agent";
  exportedAt: string;
  sourceRoot: string;
  out: string;
  memoryLayers: readonly MemoryLayer[];
  classification: ExportPathRecord[];
  owned: string[];
  related: RelatedReference[];
  unassociated: {
    skills: AssociationNone;
    workflows: AssociationNone;
    plugins: AssociationNone;
    grokboxBundledSkills: string;
    globalWorkflows: string;
    mcpCatalog: string;
  };
  omitted: Array<{ sourcePath: string; reason: string }>;
  includedRelatedWorkflows: boolean;
};

export type AgentExportSummary = {
  agentId: string;
  name: string;
  kind: "agent";
  out: string;
  exportedAt: string;
  manifest: "manifest.json";
  owned: string[];
  related: Array<{
    kind: RelatedReference["kind"];
    name: string;
    association: "reference";
    present: boolean;
  }>;
  unassociated: {
    skills: { association: "none" };
    workflows: { association: "none" };
    plugins: { association: "none" };
  };
  memoryLayers: readonly MemoryLayer[];
  includedRelatedWorkflows: boolean;
};

export type AgentExportRequest = {
  target: string;
  out: string;
  agentDataRoot: string;
  cwd: string;
  nowMs: number;
  includeRelatedWorkflows: boolean;
};

type DiskAgent = {
  id: string;
  name: string;
  title: string;
  isGroup: boolean;
  directory: string;
};

function within(root: string, target: string): boolean {
  const value = relative(root, target);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

function blockedPath(path: string): boolean {
  const normalized = resolve(path);
  const components = normalized.split(sep).filter(Boolean).map((value) => value.toLowerCase());
  const last = components.at(-1) ?? "";
  return (
    components.some((value) => BLOCKED_COMPONENTS.has(value)) ||
    BLOCKED_FILES.has(last) ||
    BLOCKED_PREFIXES.some((prefix) => last.startsWith(prefix)) ||
    BLOCKED_SUFFIXES.some((suffix) => last.endsWith(suffix))
  );
}

function sourceRel(root: string, absolute: string): string {
  const value = relative(root, absolute);
  return value.split(sep).join("/");
}

function exportJoin(root: string, exportPath: string): string {
  const parts = exportPath.split("/").filter(Boolean);
  if (parts.length === 0 || parts.some((part) => part === "." || part === "..")) {
    throw new CliError("export_path_invalid", "Export path is invalid.");
  }
  const absolute = resolve(root, ...parts);
  if (!within(root, absolute)) throw new CliError("export_path_invalid", "Export path escaped the destination.");
  return absolute;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function isEmptyDirectory(path: string): Promise<boolean> {
  const entries = await readdir(path);
  return entries.length === 0;
}

async function canonicalizeExisting(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new CliError("export_source_unavailable", "Local agent-data root was not found.");
    }
    throw error;
  }
}

async function resolveSourceRoot(raw: string, cwd: string): Promise<string> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw usage("--agent-data is required.");
  const absolute = resolve(cwd, trimmed);
  const info = await lstat(absolute).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw new CliError("export_source_unavailable", "Local agent-data root was not found.");
    }
    throw error;
  });
  if (!info.isDirectory() && !info.isSymbolicLink()) {
    throw new CliError("export_source_unavailable", "Local agent-data root is not a directory.");
  }
  const canonical = await canonicalizeExisting(absolute);
  const canonicalInfo = await stat(canonical);
  if (!canonicalInfo.isDirectory()) {
    throw new CliError("export_source_unavailable", "Local agent-data root is not a directory.");
  }
  return canonical;
}

async function resolveDestination(raw: string, cwd: string, sourceRoot: string): Promise<string> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw usage("--out is required.");
  const absolute = resolve(cwd, trimmed);
  if (absolute.includes("\0")) throw new CliError("export_path_invalid", "Export destination is invalid.");
  const parent = dirname(absolute);
  const parentInfo = await lstat(parent).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw new CliError("export_path_invalid", "Export destination parent directory was not found.");
    }
    throw error;
  });
  if (!parentInfo.isDirectory() && !parentInfo.isSymbolicLink()) {
    throw new CliError("export_path_invalid", "Export destination parent is not a directory.");
  }
  const parentReal = await realpath(parent);
  const dest = join(parentReal, basename(absolute));
  if (blockedPath(dest) || basename(dest).toLowerCase() === "gateway.json") {
    throw new CliError("export_forbidden", "Export destination is a secret or blocked path.");
  }
  if (within(sourceRoot, dest)) {
    throw new CliError("export_forbidden", "Export destination must not be inside agent-data.");
  }
  if (await exists(dest)) {
    const info = await lstat(dest);
    if (info.isSymbolicLink()) {
      const real = await realpath(dest);
      if (blockedPath(real) || within(sourceRoot, real)) {
        throw new CliError("export_forbidden", "Export destination is a secret or blocked path.");
      }
      const realInfo = await stat(real);
      if (!realInfo.isDirectory()) {
        throw new CliError("export_destination_exists", "Export destination already exists.");
      }
      if (!(await isEmptyDirectory(real))) {
        throw new CliError("export_destination_exists", "Export destination exists and is not empty.");
      }
      return real;
    }
    if (!info.isDirectory()) {
      throw new CliError("export_destination_exists", "Export destination already exists.");
    }
    if (!(await isEmptyDirectory(dest))) {
      throw new CliError("export_destination_exists", "Export destination exists and is not empty.");
    }
    await chmod(dest, 0o700).catch(() => undefined);
    return dest;
  }
  await mkdir(dest, { mode: 0o700 });
  return dest;
}

async function assertRegularWithinRoot(root: string, path: string): Promise<string> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) {
    throw new CliError("export_forbidden", "Refusing to export a symlink.");
  }
  if (!info.isFile()) {
    throw new CliError("export_forbidden", "Export source is not a regular file.");
  }
  const real = await realpath(path);
  if (!within(root, real)) {
    throw new CliError("export_forbidden", "Export source escaped the agent-data root.");
  }
  if (blockedPath(real)) {
    throw new CliError("export_forbidden", "Refusing to export a secret or blocked path.");
  }
  return real;
}

function redactJson(value: unknown, redacted: string[]): unknown {
  if (Array.isArray(value)) return value.map((entry) => redactJson(entry, redacted));
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) {
      redacted.push(key);
      continue;
    }
    out[key] = redactJson(entry, redacted);
  }
  return out;
}

async function readJsonFile(path: string): Promise<unknown | undefined> {
  try {
    const text = await readFile(path, "utf8");
    return JSON.parse(text) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function writeOwnedJson(
  destRoot: string,
  exportPath: string,
  value: unknown,
  mode = 0o600,
): Promise<void> {
  const dest = exportJoin(destRoot, exportPath);
  await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
  await writeFile(dest, `${JSON.stringify(value, null, 2)}\n`, { mode });
}

async function writeOwnedText(destRoot: string, exportPath: string, content: string): Promise<void> {
  const dest = exportJoin(destRoot, exportPath);
  await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
  await writeFile(dest, content.endsWith("\n") ? content : `${content}\n`, { mode: 0o600 });
}

async function listSubdirs(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .filter((name) => name !== "." && name !== ".." && !name.startsWith("."))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function listAgents(root: string): Promise<DiskAgent[]> {
  const agentsDir = join(root, "agents");
  const ids = await listSubdirs(agentsDir);
  const rows: DiskAgent[] = [];
  for (const id of ids) {
    const directory = join(agentsDir, id);
    const info = await lstat(directory);
    if (info.isSymbolicLink()) {
      const real = await realpath(directory).catch(() => undefined);
      if (!real || !within(root, real)) continue;
      const realInfo = await stat(real);
      if (!realInfo.isDirectory()) continue;
    } else if (!info.isDirectory()) {
      continue;
    }
    const profile = await readJsonFile(join(directory, "profile.json"));
    const rec = isRecord(profile) ? profile : {};
    rows.push({
      id,
      name: asString(rec.name),
      title: asString(rec.title),
      isGroup: await exists(join(directory, "group.json")),
      directory,
    });
  }
  return rows;
}

async function copyMemoryShard(
  sourceRoot: string,
  destRoot: string,
  shardDir: string,
  exportPrefix: string,
  layer: MemoryLayer,
  records: ExportPathRecord[],
): Promise<void> {
  const profile = join(shardDir, "profile.md");
  if (await exists(profile)) {
    const real = await assertRegularWithinRoot(sourceRoot, profile);
    const exportPath = `${exportPrefix}/profile.md`;
    await writeOwnedText(destRoot, exportPath, await readFile(real, "utf8"));
    records.push({
      exportPath,
      sourcePath: sourceRel(sourceRoot, real),
      classification: "owned",
      memoryLayer: layer,
    });
  }
  const logDir = join(shardDir, "log");
  if (!(await exists(logDir))) return;
  const logInfo = await lstat(logDir);
  if (!logInfo.isDirectory()) return;
  const files = (await readdir(logDir)).filter((name) => MEMORY_LOG_FILE.test(name)).sort();
  for (const name of files) {
    const file = join(logDir, name);
    const real = await assertRegularWithinRoot(sourceRoot, file);
    const exportPath = `${exportPrefix}/log/${name}`;
    await writeOwnedText(destRoot, exportPath, await readFile(real, "utf8"));
    records.push({
      exportPath,
      sourcePath: sourceRel(sourceRoot, real),
      classification: "owned",
      memoryLayer: layer,
    });
  }
}

function tokenMatches(text: string, name: string): boolean {
  if (name.length < 3) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_-])${escaped}([^A-Za-z0-9_-]|$)`).test(text);
}

function collectWorkflowNames(text: string, known: readonly string[]): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(WORKFLOW_REF)) {
    const name = match[1];
    if (name) found.add(name);
  }
  for (const name of known) {
    if (tokenMatches(text, name)) found.add(name);
  }
  return [...found].sort();
}

async function listWorkflowNames(root: string): Promise<string[]> {
  return await listSubdirs(join(root, "workflows"));
}

async function exportJsonRecord(
  sourceRoot: string,
  destRoot: string,
  sourcePath: string,
  exportPath: string,
  records: ExportPathRecord[],
  note?: string,
): Promise<void> {
  const absolute = join(sourceRoot, ...sourcePath.split("/"));
  if (!(await exists(absolute))) return;
  const real = await assertRegularWithinRoot(sourceRoot, absolute);
  const parsed = await readJsonFile(real);
  if (parsed === undefined) {
    records.push({
      exportPath,
      sourcePath: sourceRel(sourceRoot, real),
      classification: "owned",
      note: "Skipped invalid JSON.",
    });
    return;
  }
  const redactedKeys: string[] = [];
  const redacted = redactJson(parsed, redactedKeys);
  await writeOwnedJson(destRoot, exportPath, redacted);
  records.push({
    exportPath,
    sourcePath: sourceRel(sourceRoot, real),
    classification: "owned",
    ...(note ? { note } : {}),
    ...(redactedKeys.length > 0 ? { redactedKeys: [...new Set(redactedKeys)].sort() } : {}),
  });
}

export async function exportLocalAgent(request: AgentExportRequest): Promise<AgentExportSummary> {
  const sourceRoot = await resolveSourceRoot(request.agentDataRoot, request.cwd);
  const destRoot = await resolveDestination(request.out, request.cwd, sourceRoot);
  const agents = await listAgents(sourceRoot);
  const rosterRows = agents.map((row) => ({
    id: row.id,
    name: row.name,
    title: row.title,
    isGroup: row.isGroup,
  }));
  const row = findRosterRow(rosterRows, request.target, ["agent"]);
  const agentId = asString(row.id);
  const disk = agents.find((candidate) => candidate.id === agentId);
  if (!disk) throw new CliError("target_not_found", "No roster row matched that ID, name, or title.");

  const exportedAt = new Date(request.nowMs).toISOString();
  const records: ExportPathRecord[] = [];
  const omitted: AgentExportManifest["omitted"] = [];
  const relatedMap = new Map<string, RelatedReference>();

  await writeOwnedJson(destRoot, "roster.json", {
    id: agentId,
    name: disk.name,
    kind: "agent" as const,
  });
  records.push({
    exportPath: "roster.json",
    sourcePath: sourceRel(sourceRoot, disk.directory),
    classification: "owned",
    note: "Offline projection from the agent directory and profile.json; not a live Gateway roster row.",
  });

  await exportJsonRecord(
    sourceRoot,
    destRoot,
    `agents/${agentId}/profile.json`,
    "profile.json",
    records,
  );
  await exportJsonRecord(
    sourceRoot,
    destRoot,
    `agents/${agentId}/settings.json`,
    "settings.json",
    records,
  );
  await exportJsonRecord(
    sourceRoot,
    destRoot,
    `agents/${agentId}/projects.json`,
    "projects.json",
    records,
  );

  await copyMemoryShard(
    sourceRoot,
    destRoot,
    join(disk.directory, "memory"),
    "memory/agent",
    "agent",
    records,
  );
  await copyMemoryShard(
    sourceRoot,
    destRoot,
    join(sourceRoot, "user-memory", "by-agent", agentId),
    "memory/user",
    "user",
    records,
  );

  const projectNames = await listSubdirs(join(sourceRoot, "projects"));
  for (const slug of projectNames) {
    const shard = join(sourceRoot, "projects", slug, "memory", "by-agent", agentId);
    if (!(await exists(shard))) continue;
    await copyMemoryShard(
      sourceRoot,
      destRoot,
      shard,
      `memory/project/${slug}`,
      "project",
      records,
    );
  }

  const workflowNames = await listWorkflowNames(sourceRoot);
  const automationsDir = join(disk.directory, "automations");
  const automationIds = await listSubdirs(automationsDir);
  for (const automationId of automationIds) {
    const sourcePath = `agents/${agentId}/automations/${automationId}/automation.json`;
    const exportPath = `automations/${automationId}/automation.json`;
    const absolute = join(sourceRoot, ...sourcePath.split("/"));
    if (!(await exists(absolute))) continue;
    const real = await assertRegularWithinRoot(sourceRoot, absolute);
    const parsed = await readJsonFile(real);
    if (parsed === undefined) {
      records.push({
        exportPath,
        sourcePath: sourceRel(sourceRoot, real),
        classification: "owned",
        note: "Skipped invalid JSON.",
      });
      continue;
    }
    const redactedKeys: string[] = [];
    const redacted = redactJson(parsed, redactedKeys);
    await writeOwnedJson(destRoot, exportPath, redacted);
    records.push({
      exportPath,
      sourcePath: sourceRel(sourceRoot, real),
      classification: "owned",
      ...(redactedKeys.length > 0 ? { redactedKeys: [...new Set(redactedKeys)].sort() } : {}),
    });
    const haystack = JSON.stringify(redacted);
    for (const name of collectWorkflowNames(haystack, workflowNames)) {
      const existing = relatedMap.get(name);
      if (existing) {
        if (!existing.foundIn.includes(sourcePath)) existing.foundIn.push(sourcePath);
        continue;
      }
      relatedMap.set(name, {
        kind: "workflow",
        name,
        classification: "related",
        association: "reference",
        foundIn: [sourcePath],
        present: workflowNames.includes(name),
        note: "Text reference in an owned automation prompt; this is not bot-private ownership of the global workflows projection.",
      });
    }
  }

  const related = [...relatedMap.values()].sort((left, right) => left.name.localeCompare(right.name));
  if (request.includeRelatedWorkflows) {
    for (const ref of related) {
      if (ref.kind !== "workflow" || !ref.present) continue;
      const skillPath = join(sourceRoot, "workflows", ref.name, "SKILL.md");
      if (!(await exists(skillPath))) continue;
      const real = await assertRegularWithinRoot(sourceRoot, skillPath);
      const exportPath = `related/workflows/${ref.name}/SKILL.md`;
      await writeOwnedText(destRoot, exportPath, await readFile(real, "utf8"));
      records.push({
        exportPath,
        sourcePath: sourceRel(sourceRoot, real),
        classification: "related",
        note: "Copied because --include-related-workflows was set. Reference is not ownership.",
      });
    }
  }

  for (const name of OMITTED_TRANSCRIPT_FILES) {
    const sourcePath = `agents/${agentId}/${name}`;
    if (await exists(join(disk.directory, name))) {
      omitted.push({
        sourcePath,
        reason: "Transcript SQLite is omitted from the default export.",
      });
    }
  }
  if (await exists(join(sourceRoot, "gateway.json"))) {
    omitted.push({
      sourcePath: "gateway.json",
      reason: "Gateway discovery/credentials are never exported.",
    });
  }

  const owned = records.filter((record) => record.classification === "owned").map((record) => record.exportPath);
  const manifest: AgentExportManifest = {
    agentId,
    name: disk.name,
    kind: "agent",
    exportedAt,
    sourceRoot,
    out: destRoot,
    memoryLayers: ["agent", "user", "project"],
    classification: records,
    owned,
    related,
    unassociated: {
      skills: {
        association: "none",
        note: "Agent settings.json has no skill fields. grokbox skills list/get is the CLI bundled skill ledger, not a per-bot skill ledger.",
      },
      workflows: {
        association: "none",
        note: "agent-data/workflows is a global Grok-native projection. Related names below are text references, not ownership. Unreferenced global workflows are not listed or packed.",
      },
      plugins: {
        association: "none",
        note: "MCP/plugin membership is the Gateway catalog (SearchPlugins / InstallPlugin / listBoxMcpServers), not an agent-directory foreign key.",
      },
      grokboxBundledSkills: "Not a bot ledger; omitted.",
      globalWorkflows: "Global workflows/ is not per-bot owned; unreferenced bodies are omitted.",
      mcpCatalog: "Not scanned and not packed.",
    },
    omitted,
    includedRelatedWorkflows: request.includeRelatedWorkflows,
  };
  await writeOwnedJson(destRoot, "manifest.json", manifest);

  return {
    agentId,
    name: disk.name,
    kind: "agent",
    out: destRoot,
    exportedAt,
    manifest: "manifest.json",
    owned,
    related: related.map((item) => ({
      kind: item.kind,
      name: item.name,
      association: "reference",
      present: item.present,
    })),
    unassociated: {
      skills: { association: "none" },
      workflows: { association: "none" },
      plugins: { association: "none" },
    },
    memoryLayers: ["agent", "user", "project"],
    includedRelatedWorkflows: request.includeRelatedWorkflows,
  };
}
