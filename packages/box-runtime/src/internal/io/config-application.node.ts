import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  configApplication, configurationRevisions, isObject,
  type ConfigCommitReceipt, type UnifiedConfig,
} from "@grokbox/runtime-kernel/config";
import { publishConfigFile, readConfigFile } from "./config-layout.node.ts";
import { configurationProcessIdentity } from "./config-lock.node.ts";

export const CONFIG_CONSUMERS = ["desktop", "daemon", "runtime", "ops"] as const;
export type ConfigConsumer = typeof CONFIG_CONSUMERS[number];
export type ConfigConsumerOwner = { root: string; consumer: ConfigConsumer; instanceId: string; pid: number; uid: number; start: string | null };
type ApplicationRecord = ConfigConsumerOwner & { schemaVersion: 1; dependencyRevision: string; appliedAt: number; active: boolean };
export type ApplicationEvidence = ConfigCommitReceipt["application"] & {
  consumers?: Array<{ consumer: ConfigConsumer; state: "applied" | "pending"; reason?: string }>;
};
const location = (root: string, consumer: ConfigConsumer) => join(root, "state", "config-consumers", `${consumer}.json`);

export function configApplicationRevisions(document: UnifiedConfig, paths: readonly string[]): Partial<Record<ConfigConsumer, string>> {
  const revisions = configurationRevisions(document);
  return Object.fromEntries(CONFIG_CONSUMERS.filter((domain) => paths.some((path) => path === `/${domain}` || path.startsWith(`/${domain}/`)))
    .map((domain) => [domain, revisions[domain]]));
}
export async function createConfigConsumerOwner(root: string, consumer: ConfigConsumer): Promise<ConfigConsumerOwner> {
  const self = await configurationProcessIdentity(process.pid);
  return { root, consumer, instanceId: randomUUID(), pid: process.pid,
    uid: self.state === "present" ? self.uid : -1, start: self.state === "present" ? self.start : null };
}

/** Called by the actual consumer only after it adopts this exact snapshot, never
 * by a config query. It records configuration application, not Host activation. */
export async function publishConfigApplication(owner: ConfigConsumerOwner, document: UnifiedConfig, now = Date.now()): Promise<void> {
  const record: ApplicationRecord = { ...owner, schemaVersion: 1, dependencyRevision: configurationRevisions(document)[owner.consumer], appliedAt: now, active: true };
  await publishConfigFile(location(owner.root, owner.consumer), record);
}
export async function releaseConfigApplication(owner: ConfigConsumerOwner): Promise<void> {
  const current = await readConfigFile(location(owner.root, owner.consumer), true);
  if (!isObject(current) || current.instanceId !== owner.instanceId) return;
  await publishConfigFile(location(owner.root, owner.consumer), { ...current, active: false });
}
async function observeConsumer(root: string, consumer: ConfigConsumer, revision: string) {
  const pending = (reason: string) => ({ consumer, state: "pending" as const, reason });
  let raw: unknown;
  try { raw = await readConfigFile(location(root, consumer), true); }
  catch { return pending("application-evidence-unavailable"); }
  if (!isObject(raw) || raw.schemaVersion !== 1 || raw.root !== root || raw.consumer !== consumer ||
    raw.active !== true || typeof raw.instanceId !== "string" || !Number.isSafeInteger(raw.pid) ||
    !Number.isSafeInteger(raw.uid) || !(raw.start === null || typeof raw.start === "string")) return pending("consumer-not-observed");
  if (raw.dependencyRevision !== revision) return pending("consumer-revision-mismatch");
  const live = await configurationProcessIdentity(Number(raw.pid));
  if (live.state !== "present" || live.uid !== raw.uid || live.start === null || raw.start === null || live.start !== raw.start) return pending("consumer-liveness-unproven");
  return { consumer, state: "applied" as const };
}
export async function observeConfigApplication(root: string, receipt: Pick<ConfigCommitReceipt, "changedPaths" | "application" | "applicationRevisions">): Promise<ApplicationEvidence> {
  const expected = receipt.applicationRevisions ?? {};
  const required = CONFIG_CONSUMERS.filter((consumer) => typeof expected[consumer] === "string");
  if (!required.length) return configApplication(receipt.changedPaths);
  const consumers = await Promise.all(required.map((consumer) => observeConsumer(root, consumer, expected[consumer]!)));
  if (consumers.every((row) => row.state === "applied")) return { state: "applied", consumers };
  if (consumers.some((row) => row.consumer === "daemon" && row.state !== "applied")) return { state: "restart-required", reason: "daemon-policy-changed", consumers };
  return { state: "pending", reason: "consumer-not-observed", consumers };
}
