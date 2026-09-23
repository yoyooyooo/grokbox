import { constants, openSync, closeSync, fstatSync, lstatSync, readSync } from "node:fs";
import { mkdir, lstat, writeFile, rm } from "node:fs/promises";
import { join, dirname, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { readStableSourceSet, sourceDigest, StableSourceFailure } from "./stable-source-set.node.mjs";

export const HOST_WINDOW_LIMITS = Object.freeze({ slots: 4, sourceBytes: 64 * 1024 * 1024, profileBytes: 1024 * 1024, manifestBytes: 16384 });
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const names = Object.freeze({ source: "host.cjs", worker: "worker.cjs", profile: "profile.json" });
const maxBytes = role => role === "profile" ? HOST_WINDOW_LIMITS.profileBytes : HOST_WINDOW_LIMITS.sourceBytes;
const setDigest = files => sourceDigest(JSON.stringify([files.source.sha256, files.worker.sha256, files.profile?.sha256 ?? null]));
const windowKey = manifest => sourceDigest(JSON.stringify([manifest.sourceSet, manifest.bindings]));
const safeDirectory = stat => stat.isDirectory() && (stat.mode & 0o077) === 0 && stat.uid === process.getuid?.();
const entriesFor = paths => [{ path: paths.source, maxBytes: maxBytes("source") }, { path: paths.worker, maxBytes: maxBytes("worker") },
  ...(paths.profile === null ? [] : [{ path: paths.profile, maxBytes: maxBytes("profile"), optional: true }])];

/** A bounded private copy owned by one verification invocation, not a pin,
 * deployment, daemon or permanent source archive. Crash leftovers consume a
 * slot (fail closed) until explicitly removed; live windows are never evicted. */
export async function captureHostSourceWindow(paths, bindings, options = {}) {
  const signal = options.signal;
  if (!paths || !isAbsolute(paths.source) || !isAbsolute(paths.worker) || paths.profile !== null && !isAbsolute(paths.profile))
    throw new StableSourceFailure("source-window-inputs");
  if (!bindings || Object.keys(bindings).length > 16 || Object.entries(bindings).some(([key, value]) => !/^[a-z][A-Za-z0-9]{0,39}$/.test(key) || !hash(value)))
    throw new StableSourceFailure("source-window-bindings");
  const orderedBindings = Object.fromEntries(Object.entries(bindings).sort(([a], [b]) => a.localeCompare(b)));
  const parent = options.parent ?? join(tmpdir(), `grokbox-host-windows-${process.getuid?.()}`);
  if (!isAbsolute(parent)) throw new StableSourceFailure("source-window-directory");
  await mkdir(parent, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
  if (!safeDirectory(await lstat(parent))) throw new StableSourceFailure("source-window-directory");
  let directory;
  for (let slot = 0; slot < HOST_WINDOW_LIMITS.slots; slot++) {
    signal?.throwIfAborted();
    const candidate = join(parent, `slot-${slot}`);
    try { await mkdir(candidate, { mode: 0o700 }); directory = candidate; break; }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  if (!directory) throw new StableSourceFailure("source-window-capacity");
  const identity = await lstat(directory), ownerId = randomUUID();
  await writeFile(join(directory, ".owner"), ownerId, { flag: "wx", mode: 0o400 });
  const dispose = async () => {
    const current = await lstat(directory).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (!current) return;
    if (current.dev !== identity.dev || current.ino !== identity.ino || !safeDirectory(current)
      || readPrivate(join(directory, ".owner"), 64).toString() !== ownerId) throw new StableSourceFailure("source-window-owner-changed");
    await rm(directory, { recursive: true });
  };
  try {
    const installed = await readStableSourceSet(entriesFor(paths), signal);
    const files = {};
    for (const [index, role] of ["source", "worker", "profile"].entries()) {
      const source = installed.files[index];
      if (!source?.bytes) { files[role] = null; continue; }
      signal?.throwIfAborted();
      await writeFile(join(directory, names[role]), source.bytes, { flag: "wx", mode: 0o400 });
      files[role] = { name: names[role], sha256: source.sha256, bytes: source.bytes.length };
    }
    // No read-mid-replace set can become a candidate. Subsequent replacements
    // are freshness, independent of the successfully captured immutable bytes.
    if (!await installed.current()) throw new StableSourceFailure("source-changed");
    const manifest = { version: 1, windowId: ownerId, origin: { ...paths }, files,
      sourceSet: setDigest(files), bindings: orderedBindings, key: null };
    manifest.key = windowKey(manifest);
    const manifestPath = join(directory, "window.json");
    await writeFile(manifestPath, JSON.stringify(manifest), { flag: "wx", mode: 0o400 });
    const env = { GROKBOX_TEST_NATIVE_WINDOW: manifestPath, GROKBOX_TEST_NATIVE_WINDOW_KEY: manifest.key };
    readHostSourceWindow(env); // Validate the bytes actually materialized.
    return { directory, paths: { source: join(directory, names.source), worker: join(directory, names.worker), profile: files.profile ? join(directory, names.profile) : null },
      env, manifest, receipt: publicHostSourceWindow(manifest),
      current: async () => { try { readHostSourceWindow(env); return true; } catch { return false; } },
      freshness: () => probeHostSourceWindow(manifest, signal), dispose };
  } catch (error) { await dispose(); throw error; }
}

function readPrivate(path, maximum) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.() || (before.mode & 0o077) !== 0 || before.size < 1 || before.size > maximum)
      throw new StableSourceFailure("source-window-invalid");
    const bytes = Buffer.alloc(before.size + 1); let size = 0;
    while (size < bytes.length) { const n = readSync(fd, bytes, size, Math.min(65536, bytes.length - size), size); if (!n) break; size += n; }
    const after = fstatSync(fd), selected = lstatSync(path);
    if (size !== before.size || [after, selected].some(s => s.ino !== before.ino || s.dev !== before.dev || s.size !== before.size || s.mtimeMs !== before.mtimeMs || s.ctimeMs !== before.ctimeMs))
      throw new StableSourceFailure("source-window-changed");
    return bytes.subarray(0, size);
  } finally { closeSync(fd); }
}
/** Test consumers inherit both locator and expected key. No env locator may
 * redirect production LIVE_HOST_BUNDLE or weaken the independent ABI pin. */
export function readHostSourceWindow(env, role) {
  const path = env.GROKBOX_TEST_NATIVE_WINDOW, expectedKey = env.GROKBOX_TEST_NATIVE_WINDOW_KEY;
  if (!path || !isAbsolute(path) || !hash(expectedKey) || !safeDirectory(lstatSync(dirname(path)))) throw new StableSourceFailure("source-window-required");
  const manifest = JSON.parse(readPrivate(path, HOST_WINDOW_LIMITS.manifestBytes).toString("utf8"));
  if (manifest.version !== 1 || manifest.key !== expectedKey || !hash(manifest.sourceSet) || !manifest.bindings
    || Object.keys(manifest.bindings).length > 16 || Object.values(manifest.bindings).some(value => !hash(value))
    || manifest.key !== windowKey(manifest) || !manifest.files || manifest.sourceSet !== setDigest(manifest.files)) throw new StableSourceFailure("source-window-invalid");
  const results = {};
  for (const selected of ["source", "worker", "profile"]) {
    const item = manifest.files[selected];
    if (selected === "profile" && item === null) continue;
    if (!item || item.name !== names[selected] || !hash(item.sha256) || !Number.isSafeInteger(item.bytes) || item.bytes < 1 || item.bytes > maxBytes(selected)) throw new StableSourceFailure("source-window-invalid");
    if (role !== undefined && role !== selected) continue;
    const bytes = readPrivate(join(dirname(path), item.name), maxBytes(selected));
    if (bytes.length !== item.bytes || sourceDigest(bytes) !== item.sha256) throw new StableSourceFailure("source-window-changed");
    results[selected] = bytes;
  }
  if (role !== undefined && !results[role]) throw new StableSourceFailure("source-window-role");
  return { manifest, bytes: role === undefined ? null : results[role], paths: { source: join(dirname(path), names.source), worker: join(dirname(path), names.worker), profile: manifest.files.profile ? join(dirname(path), names.profile) : null } };
}
export function publicHostSourceWindow(manifest) {
  return { key: manifest.key, sourceSet: manifest.sourceSet, sourceSha: manifest.files.source.sha256, workerSha: manifest.files.worker.sha256,
    profileDigest: manifest.files.profile?.sha256 ?? null, bindings: manifest.bindings,
    origin: { source: sourceDigest(manifest.origin.source), worker: sourceDigest(manifest.origin.worker) },
    scope: "private-fixed-source-not-installed-or-loaded", qualified: false };
}
export async function probeHostSourceWindow(manifest, signal) {
  try {
    const fresh = await readStableSourceSet(entriesFor(manifest.origin), signal);
    const observed = { source: fresh.files[0].sha256, worker: fresh.files[1].sha256, profile: fresh.files[2]?.sha256 ?? null };
    const changedComponents = ["source", "worker", "profile"].filter(role => observed[role] !== (manifest.files[role]?.sha256 ?? null));
    return { state: changedComponents.length ? "changed" : "unchanged", observed, changedComponents, sampledAt: new Date().toISOString(), qualified: false };
  } catch (error) { return { state: "unavailable", code: error instanceof StableSourceFailure ? error.code : "source-unavailable", qualified: false }; }
}
