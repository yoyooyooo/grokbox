import { constants } from "node:fs";
import { lstat, open, readlink, rename, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Effect } from "effect";
import { ConfigError, isObject, validateConfig } from "@grokbox/runtime-kernel/config";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { parseModelsFile } from "@grokbox/runtime-kernel/selection";
import { acquireConfigurationLease } from "./config-lock.node.ts";
import { assertSafeDirectory, publishConfigFile, readConfigFile, readConfigSource, readInstallation } from "./config-layout.node.ts";

const DOCUMENTS = ["config.json", "models.json"] as const;
type Document = typeof DOCUMENTS[number];
type AliasState = { kind: "missing" | "file" | "symlink"; digest: string };
type AliasPlan = {
  schemaVersion: 1; configDir: string; root: string; installationId: string;
  canonical: Record<Document, string>; before: Record<Document, AliasState>; changes: Document[]; planDigest: string;
};
type AliasRecord = { schemaVersion: 1; plan: AliasPlan; phase: "prepared" | "repaired" };
const attempt = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: (error) => error });
const missing = (): AliasState => ({ kind: "missing", digest: sha256Text("missing") });
const same = (a: AliasState, b: AliasState) => a.kind === b.kind && a.digest === b.digest;
const wanted = (target: string): AliasState => ({ kind: "symlink", digest: sha256Text(target) });
const failure = () => new ConfigError("config_layout_conflict", "Alias repair evidence changed; preserve the detached file and preview again.");

async function inspectAlias(path: string): Promise<AliasState> {
  let info;
  try { info = await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return missing(); throw error; }
  if (process.getuid && info.uid !== process.getuid()) throw failure();
  if (info.isSymbolicLink()) return wanted(resolve(dirname(path), await readlink(path)));
  if (!info.isFile() || info.size > 128 * 1024 || (info.mode & 0o022)) throw failure();
  // Detached editor output can be malformed JSON. Preserve exact bytes without
  // parsing or treating those bytes as the authoritative document.
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const bytes = Buffer.alloc(128 * 1024 + 1); let count = 0;
    while (count < bytes.length) {
      const read = await handle.read(bytes, count, bytes.length - count, count);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    const after = await handle.stat(); const named = await lstat(path);
    if (count !== info.size || count > 128 * 1024 || after.ino !== info.ino || after.dev !== info.dev || named.ino !== info.ino ||
      after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs || named.isSymbolicLink()) throw failure();
    return { kind: "file", digest: sha256Text(bytes.subarray(0, count).toString("base64")) };
  } finally { await handle.close(); }
}
async function installation(configDir: string, expectedRoot?: string) {
  await assertSafeDirectory(configDir);
  const locator = await readConfigFile(join(configDir, "state", "layout.json"));
  if (!isObject(locator) || locator.schemaVersion !== 1 || locator.role !== "box" || typeof locator.root !== "string" ||
    resolve(locator.root) !== locator.root || typeof locator.installationId !== "string") throw failure();
  const root = locator.root;
  if (expectedRoot && resolve(expectedRoot) !== root) throw failure();
  await assertSafeDirectory(root);
  const state = await readInstallation(root);
  if (!state || state.installationId !== locator.installationId) throw failure();
  return { root, installationId: state.installationId };
}
async function canonicalDigests(root: string): Promise<Record<Document, string>> {
  const config = await readConfigSource(join(root, "config.json"));
  const models = await readConfigSource(join(root, "models.json"));
  if (!config || !models) throw failure();
  validateConfig(config.value); parseModelsFile(models.value);
  return { "config.json": config.sha256, "models.json": models.sha256 };
}
const digestPlan = ({ planDigest: _ignored, ...plan }: AliasPlan) => sha256Text(canonicalJson(plan));
async function planAliases(configDir: string, expectedRoot?: string): Promise<AliasPlan> {
  configDir = resolve(configDir);
  const id = await installation(configDir, expectedRoot);
  const before = {} as Record<Document, AliasState>; const changes: Document[] = [];
  for (const name of DOCUMENTS) {
    before[name] = await inspectAlias(join(configDir, name));
    if (configDir !== id.root && !same(before[name], wanted(join(id.root, name)))) changes.push(name);
  }
  const plan: AliasPlan = { schemaVersion: 1, configDir, ...id, canonical: await canonicalDigests(id.root), before, changes, planDigest: "" };
  plan.planDigest = digestPlan(plan); return plan;
}
export async function previewConfigurationAliases(configDir: string, expectedRoot?: string) {
  const plan = await planAliases(configDir, expectedRoot);
  return { planDigest: plan.planDigest, changes: plan.changes, detachedFiles: plan.changes.filter((name) => plan.before[name].kind !== "missing"),
    canonicalPreserved: true, mutated: false, needsRepair: plan.changes.length > 0 };
}

/** Restore managed home aliases, never replace canonical data or discard detached
 * editor output. A durable plan plus same-directory retirement makes retry safe. */
export async function repairConfigurationAliases(configDir: string, planDigest: string, expectedRoot?: string) {
  if (!/^[0-9a-f]{64}$/.test(planDigest)) throw failure();
  configDir = resolve(configDir);
  const id = await installation(configDir, expectedRoot);
  return await Effect.runPromise(Effect.acquireUseRelease(
    attempt(() => acquireConfigurationLease(id.root, false, "config-bootstrap")),
    () => Effect.acquireUseRelease(
      attempt(() => acquireConfigurationLease(id.root)),
      () => attempt(async () => {
        const receiptPath = join(id.root, "state", "config-alias-repairs", `${planDigest}.json`);
        let record = await readConfigFile(receiptPath, true) as AliasRecord | undefined;
        if (record === undefined) {
          const plan = await planAliases(configDir, expectedRoot);
          if (plan.planDigest !== planDigest) throw failure();
          record = { schemaVersion: 1, phase: "prepared", plan };
          await publishConfigFile(receiptPath, record);
        }
        if (!isObject(record) || record.schemaVersion !== 1 || !isObject(record.plan) || record.plan.planDigest !== planDigest ||
          record.plan.configDir !== configDir || record.plan.root !== id.root || record.plan.installationId !== id.installationId ||
          digestPlan(record.plan) !== planDigest || !["prepared", "repaired"].includes(record.phase)) throw failure();
        const plan = record.plan;
        if (record.phase !== "repaired" && canonicalJson(await canonicalDigests(id.root)) !== canonicalJson(plan.canonical)) throw failure();
        for (const name of plan.changes) {
          if (!DOCUMENTS.includes(name)) throw failure();
          const alias = join(configDir, name); const target = join(id.root, name);
          const backup = join(configDir, `.grokbox-${name}-${planDigest}.detached`);
          const before = plan.before[name]; const current = await inspectAlias(alias); const saved = await inspectAlias(backup);
          if (same(current, wanted(target))) {
            if (before.kind !== "missing" && !same(before, saved)) throw failure();
            continue;
          }
          if (record.phase === "repaired") throw failure();
          if (same(current, before) && before.kind !== "missing" && saved.kind === "missing") await rename(alias, backup);
          else if (!(current.kind === "missing" && (before.kind === "missing" || same(saved, before)))) throw failure();
          await symlink(target, alias);
          const parent = await open(configDir, constants.O_RDONLY);
          try { await parent.sync(); } finally { await parent.close(); }
        }
        if (record.phase !== "repaired") await publishConfigFile(receiptPath, { ...record, phase: "repaired" });
        return { repaired: true, planDigest, documents: plan.changes, canonicalPreserved: true, detachedFilesPreserved: true, servicesStarted: false };
      }),
      (lease) => attempt(lease.release).pipe(Effect.orDie),
    ),
    (lease) => attempt(lease.release).pipe(Effect.orDie),
  ));
}
