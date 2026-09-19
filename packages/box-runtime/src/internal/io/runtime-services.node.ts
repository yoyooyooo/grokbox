import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, open, readFile, rename, unlink, link, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { withJournalLock } from "../host/journal-lock.node.ts";
import { openConfigStore } from "./config-store.node.ts";
import { rootConfigLayout } from "./config-layout.node.ts";

/** Registration with a real, already available service manager. It neither
 * becomes another supervisor nor rewrites the upstream Host/desktop startup. */
export type RuntimeServiceRequest = {
  action: "install" | "status" | "uninstall";
  durableRoot: string; runRoot: string; home: string;
  releaseRoot?: string; nodeExecutable?: string;
  confirmed?: boolean; expectedPlan?: string; start?: boolean;
};
export type ServiceUnitState = { name: string; active: string; enabled: boolean; mainPid: number;
  fragmentPath: string | null; hasDropIns: boolean };
export type ServiceManager = {
  probe(): Promise<{ available: boolean; bootPersistent: boolean; reason: string }>;
  states(units: string[]): Promise<ServiceUnitState[]>;
  reload(): Promise<void>; enable(units: string[], start: boolean): Promise<void>; disable(units: string[]): Promise<void>;
};
export class RuntimeServiceError extends Error {
  constructor(readonly reason: string) { super(`runtime_services_${reason}`); this.name = "RuntimeServiceError"; }
}
const bad = (reason: string): never => { throw new RuntimeServiceError(reason); };
const missing = (e: unknown) => e && typeof e === "object" && "code" in e && e.code === "ENOENT";
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const LIMIT = 16 * 1024;
function path(value: unknown): string {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) === "/" || value.length > 2048 || value.trim() !== value || /[\x00-\x1f\x7f%$\\]/.test(value)) return bad("invalid_path");
  return resolve(value);
}
const quote = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
async function directory(value: string, create = false) {
  if (create) try { await mkdir(value, { mode: 0o700 }); } catch (e) { if (!(e && typeof e === "object" && "code" in e && e.code === "EEXIST")) throw e; }
  const st = await lstat(value);
  if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o022) !== 0 || process.getuid && st.uid !== process.getuid()) return bad("unsafe_directory");
}
async function privateText(file: string): Promise<string | null> {
  let fd;
  try {
    fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await fd.stat();
    if (!before.isFile() || ![1, 2].includes(before.nlink) || before.size > LIMIT || (before.mode & 0o077) !== 0 || process.getuid && before.uid !== process.getuid()) return bad("unsafe_file");
    if (before.nlink === 2) {
      // Exclusive publish is link+unlink. Only its precise canonical/staging pair
      // may be read after a crash between those calls, never an arbitrary alias.
      const paired = await lstat(file.endsWith(".next") ? file.slice(0, -5) : `${file}.next`);
      if (!paired.isFile() || paired.isSymbolicLink() || paired.dev !== before.dev || paired.ino !== before.ino || paired.nlink !== 2) return bad("unsafe_file");
    }
    const bytes = Buffer.alloc(LIMIT + 1); const read = await fd.read(bytes, 0, bytes.length, 0);
    const after = await fd.stat(), named = await lstat(file);
    if (read.bytesRead !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || named.dev !== before.dev || named.ino !== before.ino) return bad("file_changed");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, read.bytesRead));
  } catch (e) { if (!fd && missing(e)) return null; throw e; } finally { await fd?.close(); }
}
async function artifact(file: string, maxBytes = 64 * 1024 * 1024) {
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes || before.size < 1 || (before.mode & 0o022) !== 0
    || process.getuid && before.uid !== process.getuid() && before.uid !== 0) return bad("unsafe_artifact");
  const digest = createHash("sha256"), fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const pinned = await fd.stat(); if (pinned.dev !== before.dev || pinned.ino !== before.ino) return bad("artifact_changed");
    const buffer = Buffer.alloc(1024 * 1024); let used = 0;
    for (;;) {
      const read = await fd.read(buffer, 0, Math.min(buffer.length, maxBytes + 1 - used), used);
      if (!read.bytesRead) break;
      used += read.bytesRead; if (used > maxBytes) return bad("artifact_changed"); digest.update(buffer.subarray(0, read.bytesRead));
    }
    const after = await lstat(file), final = await fd.stat();
    if (used !== before.size || final.size !== before.size || final.mtimeMs !== before.mtimeMs || after.dev !== before.dev || after.ino !== before.ino
      || after.size !== before.size || after.mtimeMs !== before.mtimeMs) return bad("artifact_changed");
    return digest.digest("hex");
  } finally { await fd.close(); }
}
function exec(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile(command, args, { timeout: 8000, maxBuffer: 8192, encoding: "utf8", env: process.env }, (error, stdout) => {
    if (error) reject(new RuntimeServiceError("manager_unavailable")); else resolve(stdout.trim());
  }));
}
export function systemdUserManager(): ServiceManager {
  const unit = (value: string) => { if (!/^grokbox-[a-f0-9]{16}-(?:daemon|modeld)\.service$/.test(value)) return bad("invalid_unit"); return value; };
  return {
    probe: async () => {
      if (process.platform !== "linux" || !process.getuid) return { available: false, bootPersistent: false, reason: "unsupported_platform" };
      try {
        const version = await exec("systemctl", ["--user", "--no-pager", "show", "--property=Version", "--value"]);
        if (!version) return { available: false, bootPersistent: false, reason: "user_manager_unavailable" };
        const linger = await exec("loginctl", ["show-user", String(process.getuid()), "--property=Linger", "--value"]);
        return { available: true, bootPersistent: linger === "yes", reason: linger === "yes" ? "ready" : "linger_not_enabled" };
      } catch { return { available: false, bootPersistent: false, reason: "user_manager_unavailable" }; }
    },
    states: async units => Promise.all(units.map(async name => {
      const text = await exec("systemctl", ["--user", "--no-pager", "show", unit(name), "--property=ActiveState,UnitFileState,MainPID,FragmentPath,DropInPaths"]);
      const rows = Object.fromEntries(text.split("\n").map(line => { const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)]; }));
      const pid = Number(rows.MainPID ?? 0);
      if (!Number.isSafeInteger(pid) || pid < 0 || !["active", "inactive", "failed", "activating", "deactivating", "reloading", "maintenance"].includes(rows.ActiveState ?? "")) return bad("manager_state_invalid");
      if (rows.FragmentPath === undefined || rows.DropInPaths === undefined) return bad("manager_state_invalid");
      return { name, active: rows.ActiveState!, enabled: rows.UnitFileState === "enabled", mainPid: pid,
        fragmentPath: rows.FragmentPath || null, hasDropIns: rows.DropInPaths !== "" };
    })),
    reload: async () => { await exec("systemctl", ["--user", "daemon-reload"]); },
    enable: async (units, start) => { await exec("systemctl", ["--user", "enable", ...(start ? ["--now"] : []), ...units.map(unit)]); },
    disable: async units => { await exec("systemctl", ["--user", "disable", ...units.map(unit)]); },
  };
}

type Unit = { name: string; component: "daemon" | "modeld"; text: string; digest: string };
type Registration = { schemaVersion: 1; scope: string; requestDigest: string; phase: "preparing" | "installed" | "removing" | "retired";
  release: string; node: string; artifacts: { entry: string; preload: string; node: string }; units: Unit[] };
function registration(text: string | null): Registration | null {
  if (text === null) return null;
  const v = JSON.parse(text) as Registration;
  if (!v || v.schemaVersion !== 1 || !hash(v.scope) || !hash(v.requestDigest) || !["preparing", "installed", "removing", "retired"].includes(v.phase)
    || !Array.isArray(v.units) || v.units.length !== 2 || !v.artifacts || ![v.artifacts.entry, v.artifacts.preload, v.artifacts.node].every(hash)) return bad("registration_invalid");
  path(v.release); path(v.node);
  for (const u of v.units) if (!u || !["daemon", "modeld"].includes(u.component) || u.name !== `grokbox-${v.scope.slice(0, 16)}-${u.component}.service`
    || typeof u.text !== "string" || u.text.length > 6000 || sha256Text(u.text) !== u.digest) return bad("registration_invalid");
  if (new Set(v.units.map(u => u.component)).size !== 2 || sha256Text(canonicalJson({ scope: v.scope, release: v.release, node: v.node,
    artifacts: v.artifacts, units: v.units })) !== v.requestDigest) return bad("registration_invalid");
  return v;
}
async function syncDirectory(dir: string) { const fd = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { await fd.sync(); } finally { await fd.close(); } }
async function publish(file: string, text: string, replace: boolean) {
  if (Buffer.byteLength(text) > LIMIT) return bad("registration_capacity");
  const temp = `${file}.next`;
  const pending = await privateText(temp);
  if (pending !== null && pending !== text) return bad("staging_requires_reconciliation");
  if (pending === null) { const fd = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await fd.writeFile(text); await fd.sync(); } finally { await fd.close(); } }
  const staged = await lstat(temp), current = await lstat(file).catch(e => { if (missing(e)) return null; throw e; });
  if (current && current.dev === staged.dev && current.ino === staged.ino && current.isFile() && current.nlink === 2 && staged.nlink === 2) await unlink(temp);
  else if (replace) await rename(temp, file);
  else { await link(temp, file); await unlink(temp); }
  await syncDirectory(dirname(file));
}
// Constant pre-start program executes only before the installed entry, never
// through that unverified entry. It checks bounded regular files each restart.
const CHECK_RELEASE = "const f=require('node:fs'),c=require('node:crypto');for(let i=1;i<process.argv.length;i+=2){const p=process.argv[i],s=f.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||s.size>67108864)process.exit(78);const h=c.createHash('sha256').update(f.readFileSync(p)).digest('hex');if(h!==process.argv[i+1])process.exit(78)}";
function loadedDefinitions(states: ServiceUnitState[], units: Unit[], unitDir: string, absent = false, missingNames: ReadonlySet<string> = new Set()) {
  if (states.length !== units.length || states.some((s, i) => s.name !== units[i]!.name || s.hasDropIns
    || (absent || missingNames.has(s.name) ? s.fragmentPath !== null : s.fragmentPath !== join(unitDir, units[i]!.name)))) return bad("manager_definition_mismatch");
}
const publicStates = (states: ServiceUnitState[]) => states.map(({ fragmentPath: _path, hasDropIns, ...state }) => ({ ...state, hasDropIns }));
function render(scope: string, component: Unit["component"], root: string, run: string, home: string, release: string, node: string, artifacts: Registration["artifacts"]): Unit {
  const name = `grokbox-${scope.slice(0, 16)}-${component}.service`, entry = join(release, "dist/index.js");
  const args = component === "daemon" ? ["daemon", "serve", "--socket", join(run, "daemon.sock"), "--json"] : ["runtime", "modeld", "run", "--json"];
  const text = ["# grokbox-owned-runtime-service-v1", "[Unit]", `Description=grokbox ${component} (${scope.slice(0, 16)})`,
    "StartLimitIntervalSec=300", "StartLimitBurst=3", "", "[Service]", "Type=exec", "UMask=0077",
    // A user's service-manager environment is not a verified loader policy.
    // These can execute code before our pre-start artifact check even runs.
    "UnsetEnvironment=NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH",
    `WorkingDirectory=${release}`, ...Object.entries({ HOME: home, GROKBOX_CONFIG_DIR: root, GROKBOX_BOX_RUNTIME_ROOT: root, GROKBOX_RUN_ROOT: run }).map(([k, v]) => `Environment=${quote(`${k}=${v}`)}`),
    `ExecStartPre=${[node, "--eval", CHECK_RELEASE, entry, artifacts.entry, join(release, "dist/preload.cjs"), artifacts.preload].map(quote).join(" ")}`,
    `ExecStart=${[node, entry, ...args].map(quote).join(" ")}`, "Restart=on-failure", "RestartSec=30", "TimeoutStopSec=40",
    "KillMode=mixed", "SendSIGKILL=no", "StandardOutput=null", "StandardError=null", "", "[Install]", "WantedBy=default.target", ""].join("\n");
  return { name, component, text, digest: sha256Text(text) };
}

export async function runtimeServices(input: RuntimeServiceRequest, manager: ServiceManager = systemdUserManager()) {
  if (!["install", "status", "uninstall"].includes(input.action)) return bad("invalid_action");
  const root = path(input.durableRoot), run = path(input.runRoot), home = path(input.home);
  const unitDir = join(home, ".config/systemd/user"), state = join(root, "state"), file = join(state, "runtime-services.json");
  const scope = sha256Text(canonicalJson(["runtime-services-v1", root, run, home, process.getuid?.() ?? -1]));
  await directory(root); await directory(run); await directory(home);
  for (const parent of [state, join(home, ".config"), join(home, ".config/systemd"), unitDir]) {
    try { await directory(parent); } catch (e) { if (!missing(e)) throw e; }
  }
  const savedText = await privateText(file), saved = registration(savedText);
  const pendingText = await privateText(`${file}.next`), pending = registration(pendingText);
  if (saved && saved.scope !== scope || pending && pending.scope !== scope) return bad("scope_changed");
  const environment = await manager.probe();
  if (input.action === "status") {
    const units = saved ? await Promise.all(saved.units.map(async u => ({ name: u.name, definitionMatched: await privateText(join(unitDir, u.name)) === u.text }))) : [];
    let observed: Awaited<ReturnType<ServiceManager["states"]>> | null = null;
    if (environment.available && saved) try { observed = await manager.states(saved.units.map(u => u.name)); } catch { /* explicit unavailable */ }
    let artifactsMatched: boolean | null = null;
    if (saved) try { artifactsMatched = await artifact(join(saved.release, "dist/index.js")) === saved.artifacts.entry
      && await artifact(join(saved.release, "dist/preload.cjs")) === saved.artifacts.preload && await artifact(saved.node, 256 * 1024 * 1024) === saved.artifacts.node; }
    catch { artifactsMatched = false; }
    let loadedDefinitionsMatched: boolean | null = null;
    if (saved && observed) { try { loadedDefinitions(observed, saved.units, unitDir, saved.phase === "retired"); loadedDefinitionsMatched = true; }
      catch { loadedDefinitionsMatched = false; } }
    return { schemaVersion: 1, scope, environment, phase: saved?.phase ?? "not_installed", units,
      managerObserved: observed ? publicStates(observed) : null, loadedDefinitionsMatched, artifactsMatched, pendingPhase: pending?.phase ?? null,
      filesMatched: saved ? units.every(u => u.definitionMatched) : false, executionQualified: false, createsServices: false };
  }
  let target: Registration, configRevision: string | null = null;
  if (input.action === "install") {
    const release = path(input.releaseRoot), node = path(await realpath(path(input.nodeExecutable)));
    const releaseInfo = await lstat(release);
    if (!releaseInfo.isDirectory() || releaseInfo.isSymbolicLink() || (releaseInfo.mode & 0o022) !== 0
      || process.getuid && releaseInfo.uid !== process.getuid() && releaseInfo.uid !== 0) return bad("unsafe_artifact");
    if (await lstat(join(release, ".git")).then(() => true, e => { if (missing(e)) return false; throw e; })) return bad("source_checkout_not_release");
    const pkgFile = join(release, "package.json"); await artifact(pkgFile, 64 * 1024);
    const pkg = JSON.parse(await readFile(pkgFile, "utf8")); if (pkg.name !== "grokbox") return bad("wrong_package");
    const version = /^v(\d+)\.(\d+)\.(\d+)$/.exec(await exec(node, ["--version"]));
    if (!version || Number(version[1]) < 20 || Number(version[1]) === 20 && Number(version[2]) < 17) return bad("node_version_unsupported");
    const config = await openConfigStore(rootConfigLayout(root)).read(); configRevision = config.revision;
    if (config.document.daemon?.observation && config.document.daemon.observation.runRoot !== run) return bad("collector_root_mismatch");
    const artifacts = { entry: await artifact(join(release, "dist/index.js")), preload: await artifact(join(release, "dist/preload.cjs")), node: await artifact(node, 256 * 1024 * 1024) };
    const units = ["modeld", "daemon"].map(c => render(scope, c as Unit["component"], root, run, home, release, node, artifacts));
    const requestDigest = sha256Text(canonicalJson({ scope, release, node, artifacts, units }));
    target = { schemaVersion: 1, scope, release, node, artifacts, units, requestDigest, phase: "preparing" };
    if (saved && saved.phase !== "retired" && saved.requestDigest !== requestDigest) return bad("explicit_retirement_required");
  } else {
    if (!saved) return bad("not_installed"); target = saved;
  }
  const names = target.units.map(u => u.name);
  const currentFiles = await Promise.all(target.units.map(async u => ({ name: u.name, content: await privateText(join(unitDir, u.name)) })));
  for (const [i, value] of currentFiles.entries()) {
    if (!saved || saved.phase === "retired") { if (value.content !== null) return bad("unit_already_exists"); }
    else if (value.content !== null && value.content !== target.units[i]!.text) return bad("unit_changed");
  }
  const planDigest = sha256Text(canonicalJson({ action: input.action, request: target.requestDigest, saved: savedText === null ? null : sha256Text(savedText), pending: pendingText === null ? null : sha256Text(pendingText),
    files: currentFiles.map(f => f.content === null ? null : sha256Text(f.content)), configRevision, start: input.start === true }));
  const preview = { schemaVersion: 1, action: input.action, scope, planDigest, environment, units: names,
    releaseRevision: target.requestDigest, startsNow: input.action === "install" && input.start === true,
    affectsHost: false, importsShellCredentials: false, executionQualified: false, written: false };
  if (input.confirmed !== true) return preview;
  if (input.expectedPlan !== planDigest) return bad("plan_conflict");
  if (input.action === "uninstall" && saved?.phase === "retired") return { ...preview, written: false, phase: "retired" as const, unchanged: true };
  if (!environment.available || !environment.bootPersistent) return bad(environment.reason);
  await directory(state, true);
  return withJournalLock(join(state, "runtime-services.lock"), async () => {
    if (await privateText(file) !== savedText || await privateText(`${file}.next`) !== pendingText) return bad("plan_conflict");
    for (const [i, u] of target.units.entries()) if (await privateText(join(unitDir, u.name)) !== currentFiles[i]!.content) return bad("plan_conflict");
    if (input.action === "install" && (await openConfigStore(rootConfigLayout(root)).read()).revision !== configRevision) return bad("plan_conflict");
    if (input.action === "install" && (await artifact(join(target.release, "dist/index.js")) !== target.artifacts.entry
      || await artifact(join(target.release, "dist/preload.cjs")) !== target.artifacts.preload || await artifact(target.node, 256 * 1024 * 1024) !== target.artifacts.node)) return bad("artifact_changed");
    const currentEnv = await manager.probe(); if (!currentEnv.available || !currentEnv.bootPersistent) return bad(currentEnv.reason);
    for (const p of [join(home, ".config"), join(home, ".config/systemd"), unitDir]) await directory(p, true);
    if (input.action === "uninstall") {
      const active = await manager.states(names);
      const absent = new Set(currentFiles.filter(f => f.content === null).map(f => f.name));
      if (absent.size && !["preparing", "removing"].includes(saved?.phase ?? "")) return bad("unit_missing");
      loadedDefinitions(active, target.units, unitDir, false, absent);
      if (active.some(u => !["inactive", "failed"].includes(u.active) || u.mainPid !== 0)) return bad("services_must_be_stopped");
    }
    if (pending && ["installed", "retired"].includes(pending.phase)) {
      // A lost final local acknowledgement cannot justify replaying manager
      // actions. Complete only the already-staged result after fresh readback.
      const expectedPhase = input.action === "install" ? "installed" : "retired";
      if (pending.requestDigest !== target.requestDigest || pending.phase !== expectedPhase) return bad("staging_requires_reconciliation");
      for (const u of target.units) {
        const present = await privateText(join(unitDir, u.name));
        if (present !== (expectedPhase === "installed" ? u.text : null)) return bad("unit_changed");
        const staged = await privateText(`${join(unitDir, u.name)}.next`);
        if (staged !== null) {
          if (expectedPhase !== "installed" || staged !== u.text) return bad("staging_requires_reconciliation");
          await publish(join(unitDir, u.name), u.text, true);
        }
      }
      const observed = await manager.states(names);
      loadedDefinitions(observed, target.units, unitDir, expectedPhase === "retired");
      if (observed.some(s => s.enabled !== (expectedPhase === "installed")
        || expectedPhase === "retired" && (s.mainPid !== 0 || !["inactive", "failed"].includes(s.active))
        || input.start === true && !["active", "activating"].includes(s.active))) return bad("manager_readback_mismatch");
      await publish(file, pendingText!, savedText !== null);
      return { ...preview, phase: expectedPhase, written: true, reconciled: true, managerObserved: publicStates(observed) };
    }
    // Persist the exact intent before manager changes. Recovery may resume only
    // matching owned definitions; unknown/mismatched content is never replaced.
    const preparing = { ...target, phase: input.action === "install" ? "preparing" as const : "removing" as const };
    await publish(file, JSON.stringify(preparing) + "\n", savedText !== null);
    try {
      for (const u of target.units) {
        const present = await privateText(join(unitDir, u.name));
        if (present !== null && present !== u.text) return bad("unit_changed");
        if (input.action === "install") {
          const staged = await privateText(`${join(unitDir, u.name)}.next`);
          if (staged !== null && staged !== u.text) return bad("staging_requires_reconciliation");
          if (present === null || staged !== null) await publish(join(unitDir, u.name), u.text, present !== null);
        }
      }
      if (input.action === "install") {
        await manager.reload();
        loadedDefinitions(await manager.states(names), target.units, unitDir);
        if ((await openConfigStore(rootConfigLayout(root)).read()).revision !== configRevision) return bad("plan_conflict");
        await manager.enable(names, input.start === true);
      }
      else {
        await manager.disable(names);
        const stillStopped = await manager.states(names);
        loadedDefinitions(stillStopped, target.units, unitDir, false, new Set(currentFiles.filter(f => f.content === null).map(f => f.name)));
        if (stillStopped.some(u => !["inactive", "failed"].includes(u.active) || u.mainPid !== 0)) return bad("services_must_be_stopped");
        for (const u of target.units) {
          const present = await privateText(join(unitDir, u.name));
          if (present === null && currentFiles.some(f => f.name === u.name && f.content === null)) continue;
          if (present !== u.text) return bad("unit_changed");
          await unlink(join(unitDir, u.name));
        }
        await syncDirectory(unitDir); await manager.reload();
      }
      const managerObserved = await manager.states(names);
      loadedDefinitions(managerObserved, target.units, unitDir, input.action === "uninstall");
      if (managerObserved.length !== names.length || managerObserved.some((u, i) => u.name !== names[i]
        || u.enabled !== (input.action === "install") || input.action === "install" && input.start === true && !["active", "activating"].includes(u.active))) return bad("manager_readback_mismatch");
      const phase = input.action === "install" ? "installed" as const : "retired" as const;
      await publish(file, JSON.stringify({ ...target, phase }) + "\n", true);
      return { ...preview, written: true, phase, managerObserved: publicStates(managerObserved) };
    } catch (e) { if (e instanceof RuntimeServiceError && e.reason === "unit_changed") throw e; return bad("installation_outcome_unknown"); }
  }, 1);
}
