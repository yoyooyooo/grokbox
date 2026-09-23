import { constants } from "node:fs";
import { lstat, mkdir, open, readlink, realpath, symlink, rename, unlink, link } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { ConfigError, CONFIG_MAX_BYTES, isObject, parseConfigJson } from "@grokbox/runtime-kernel/config";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";

export type ConfigLayout = {
  role: "client" | "box";
  configDir: string;
  root: string;
  configPath: string;
  modelsPath?: string;
  installationId?: string;
};
export type InstallationState = {
  schemaVersion: 1;
  installationId: string;
  role: "box";
  root: string;
  desktop?: { floorAgentIds?: string[]; stopWindowPath?: string };
  daemon?: { tokenSha256?: string };
};
export function rootConfigLayout(root: string): ConfigLayout {
  if (!isAbsolute(root)) throw new ConfigError("config_layout_conflict", "Configuration root must be absolute.");
  const canonical = resolve(root);
  return { role: "box", root: canonical, configDir: canonical, configPath: join(canonical, "config.json"), modelsPath: join(canonical, "models.json") };
}
export async function assertSafeDirectory(path: string, create = false): Promise<void> {
  const absolute = resolve(path);
  const parts = absolute.split("/").filter(Boolean);
  let cursor = "/";
  for (const part of parts) {
    cursor = join(cursor, part);
    let info;
    try { info = await lstat(cursor); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create) throw new ConfigError("config_layout_conflict", "Configuration directory is unavailable.");
      try { await mkdir(cursor, { mode: 0o700 }); } catch (creation) {
        if ((creation as NodeJS.ErrnoException).code !== "EEXIST") throw creation;
      }
      info = await lstat(cursor);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new ConfigError("config_layout_conflict", "Configuration parents must be real directories.");
  }
  const info = await lstat(absolute);
  if ((typeof process.getuid === "function" && info.uid !== process.getuid()) || (info.mode & 0o022)) {
    throw new ConfigError("config_layout_conflict", "Configuration directory has unsafe ownership or permissions.");
  }
}

/** Read only a bounded, no-follow, same-owner regular file. Missing is distinct
 * from corrupt. These readers never initialize, migrate, or repair. */
export async function readConfigSource(path: string, optional = false): Promise<{ value: unknown; text: string; sha256: string } | undefined> {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ConfigError("config_invalid", "Configuration file is unavailable or is a symlink.");
  }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > CONFIG_MAX_BYTES || (before.mode & 0o022) ||
      (typeof process.getuid === "function" && before.uid !== process.getuid())) {
      throw new ConfigError("config_invalid", "Configuration must be a bounded, protected regular file.");
    }
    const bytes = Buffer.alloc(CONFIG_MAX_BYTES + 1);
    let total = 0;
    while (total < bytes.length) {
      const read = await handle.read(bytes, total, bytes.length - total, total);
      if (!read.bytesRead) break;
      total += read.bytesRead;
    }
    const after = await handle.stat(); const named = await lstat(path);
    if (total > CONFIG_MAX_BYTES || before.size !== total || before.dev !== named.dev || before.ino !== named.ino ||
      before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || named.isSymbolicLink()) {
      throw new ConfigError("config_conflict", "Configuration changed while being read.");
    }
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, total)); }
    catch { throw new ConfigError("config_invalid", "Configuration is not valid UTF-8."); }
    return { value: parseConfigJson(text), text, sha256: sha256Text(text) };
  } finally { await handle.close(); }
}
export async function readConfigFile(path: string, optional = false): Promise<unknown | undefined> {
  return (await readConfigSource(path, optional))?.value;
}

/** One physical publication primitive, reused for config, receipts and migration.
 * Callers own lock/expected-value checks. No-follow applies to destination and parents. */
export async function publishConfigFile(path: string, value: unknown, sourceText?: string, exclusive = false, beforePublish?: () => Promise<void>): Promise<void> {
  const parent = dirname(path);
  await assertSafeDirectory(parent, true);
  const parentBefore = await lstat(parent);
  const temporary = join(parent, `.grokbox-${randomUUID()}.tmp`);
  const text = sourceText ?? `${JSON.stringify(value, null, 2)}\n`;
  if (sourceText !== undefined && canonicalJson(parseConfigJson(sourceText)) !== canonicalJson(value)) throw new ConfigError("config_invalid", "Backup source bytes do not match the captured document.");
  if (Buffer.byteLength(text) > CONFIG_MAX_BYTES) throw new ConfigError("config_invalid", "Configuration publication exceeds 128 KiB.");
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  let published = false;
  try {
    await handle.writeFile(text, "utf8"); await handle.sync();
    const parentNow = await lstat(parent);
    if (parentNow.dev !== parentBefore.dev || parentNow.ino !== parentBefore.ino) throw new ConfigError("config_layout_conflict", "Configuration parent changed.");
    try {
      const destination = await lstat(path);
      if (!destination.isFile() || destination.isSymbolicLink()) throw new ConfigError("config_layout_conflict", "Refusing to replace a non-regular canonical file.");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    // Check after staging IO, immediately before the first canonical write.
    await beforePublish?.();
    if (exclusive) {
      await link(temporary, path);
      await unlink(temporary);
    } else await rename(temporary, path);
    published = true;
    const directory = await open(parent, constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await handle.close();
    if (!published) await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  }
}

export async function readConfigLayout(configDir: string, expectedRoot?: string): Promise<ConfigLayout> {
  if (!isAbsolute(configDir)) throw new ConfigError("config_layout_conflict", "Configuration directory must be absolute.");
  const dir = resolve(configDir);
  const locator = await readConfigFile(join(dir, "state", "layout.json"), true);
  if (locator === undefined) {
    const path = join(dir, "config.json");
    try { if ((await lstat(path)).isSymbolicLink()) throw new ConfigError("config_layout_conflict", "Unmanaged configuration alias."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return { role: "client", configDir: dir, root: dir, configPath: path };
  }
  if (!isObject(locator) || Object.keys(locator).some((key) => !["schemaVersion", "role", "root", "installationId"].includes(key)) ||
    locator.schemaVersion !== 1 || locator.role !== "box" || typeof locator.root !== "string" || !isAbsolute(locator.root) ||
    typeof locator.installationId !== "string" || !/^[0-9a-f-]{36}$/.test(locator.installationId)) {
    throw new ConfigError("config_layout_conflict", "Invalid installation locator.");
  }
  const root = resolve(locator.root);
  if (expectedRoot && resolve(expectedRoot) !== root) throw new ConfigError("config_layout_conflict", "Requested root does not match the installed root.");
  await assertSafeDirectory(root);
  const installation = await readInstallation(root);
  if (!installation || installation.installationId !== locator.installationId) throw new ConfigError("config_layout_conflict", "Installation identity does not match the locator.");
  for (const document of ["config.json", "models.json"]) {
    const alias = join(dir, document); const canonical = join(root, document);
    if (alias === canonical) continue;
    let target: string;
    try { target = await readlink(alias); } catch { throw new ConfigError("config_layout_conflict", "Missing or replaced configuration alias; use the migration recovery command."); }
    if (resolve(dirname(alias), target) !== canonical) throw new ConfigError("config_layout_conflict", "Configuration alias points at another installation.");
  }
  return { ...rootConfigLayout(root), configDir: dir, installationId: locator.installationId };
}
export async function readInstallation(root: string): Promise<InstallationState | undefined> {
  const value = await readConfigFile(join(root, "state", "installation.json"), true);
  return value === undefined ? undefined : validateInstallationState(value, root);
}
export function validateInstallationState(value: unknown, root: string): InstallationState {
  if (!isObject(value) || value.schemaVersion !== 1 || value.role !== "box" || value.root !== resolve(root) ||
    typeof value.installationId !== "string" || !/^[0-9a-f-]{36}$/.test(value.installationId) ||
    Object.keys(value).some((key) => !["schemaVersion", "role", "root", "installationId", "desktop", "daemon"].includes(key))) {
    throw new ConfigError("config_layout_conflict", "Invalid installation security state.");
  }
  if (value.desktop !== undefined) {
    if (!isObject(value.desktop) || Object.keys(value.desktop).some((key) => !["floorAgentIds", "stopWindowPath"].includes(key)) ||
      (value.desktop.stopWindowPath !== undefined && (typeof value.desktop.stopWindowPath !== "string" || !isAbsolute(value.desktop.stopWindowPath))) ||
      (value.desktop.floorAgentIds !== undefined && (!Array.isArray(value.desktop.floorAgentIds) || value.desktop.floorAgentIds.length > 64 || new Set(value.desktop.floorAgentIds).size !== value.desktop.floorAgentIds.length || value.desktop.floorAgentIds.some((id) => typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))))) throw new ConfigError("config_layout_conflict", "Invalid installation desktop policy.");
  }
  if (value.daemon !== undefined && (!isObject(value.daemon) || Object.keys(value.daemon).some((key) => key !== "tokenSha256") ||
    (value.daemon.tokenSha256 !== undefined && (typeof value.daemon.tokenSha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.daemon.tokenSha256))))) throw new ConfigError("config_layout_conflict", "Invalid installation credential verifier.");
  return structuredClone(value) as InstallationState;
}

/** Called only by confirmed installation/migration; never overwrite an alias conflict. */
export async function publishLayoutAliases(configDir: string, root: string, installationId: string): Promise<void> {
  await assertSafeDirectory(configDir, true);
  for (const document of ["config.json", "models.json"]) {
    const alias = join(resolve(configDir), document); const canonical = join(resolve(root), document);
    if (alias === canonical) continue;
    try { await symlink(canonical, alias); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let target: string;
      try { target = await readlink(alias); } catch { throw new ConfigError("config_layout_conflict", "Existing file blocks configuration alias; preserve it and resolve the migration conflict."); }
      if (resolve(dirname(alias), target) !== canonical) throw new ConfigError("config_layout_conflict", "Existing alias belongs to another root.");
    }
  }
  await publishConfigFile(join(configDir, "state", "layout.json"), { schemaVersion: 1, role: "box", root: resolve(root), installationId });
}
