import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { OpsPairingError, OPS_PAIRING_POLICY, pairingFail, pairingAlias, pairingOperation, pairingReceipt, pairingScope, validatePairingCredential,
  validateNotificationTarget, type PairingRecord, type PairingPlan, type PairingCredential, type NotificationBinding, type NativeNotificationResult } from "@grokbox/runtime-kernel/observation";
import { routineAgentId, routineId, routineRevision } from "@grokbox/runtime-kernel/routines";
import { acquireConfigurationLease } from "./config-lock.node.ts";
import { assertSafeDirectory } from "./config-layout.node.ts";
import { sendNativeNotification, type NotificationRequest } from "./native-notification.node.ts";

type Slot = PairingRecord & { credential: PairingCredential | null };
type Capsule = { schemaVersion: 1; owner: "ops-pairing"; rootId: string; slots: Slot[] };
const absent = (e: unknown) => !!e && typeof e === "object" && "code" in e && e.code === "ENOENT";
const privateFile = (s: { mode: number; uid: number; nlink: number }) => (s.mode & 0o077) === 0 && s.nlink === 1 && (!process.getuid || s.uid === process.getuid());
function projected(slot: Slot): PairingRecord { const { credential: _, ...record } = slot; return structuredClone(record); }

/** A single atomic PRIVATE credential capsule, not ordinary config or an export.
 * The two fixed files and eight bounded slots avoid cross-file key/receipt
 * publication races and orphan growth. No public accessor returns a credential.
 * All mutations use the existing config lease; no network runs under that lock. */
export function openOpsBindings(durableRoot: string) {
  const root = resolve(durableRoot), directory = join(root, "state/ops-pairing"), path = join(directory, "bindings.json"), temp = join(directory, "bindings.next.json");
  const rootId = sha256Text(canonicalJson(["ops-pairing-v1", root]));
  function parse(value: unknown): Capsule {
    if (!value || typeof value !== "object") return pairingFail("store_unavailable");
    const v = value as Capsule;
    if (v.schemaVersion !== 1 || v.owner !== "ops-pairing" || v.rootId !== rootId || !Array.isArray(v.slots) || v.slots.length > OPS_PAIRING_POLICY.maxSlots) return pairingFail("store_unavailable");
    const names = new Set<string>(), ids = new Set<string>();
    for (const slot of v.slots) {
      if (!slot || !slot.plan || !["enrolling", "prepared", "disabled", "unbound"].includes(slot.state)
        || !Number.isSafeInteger(slot.revision) || slot.revision < 1 || !Number.isSafeInteger(slot.updatedAtMs) || slot.updatedAtMs < 1) return pairingFail("store_unavailable");
      const p = slot.plan; pairingOperation(p.operationId); pairingScope(p.scope); validateNotificationTarget(p.target); routineId(p.routineId); routineRevision(p.routineRevision); routineRevision(p.generation); routineAgentId(slot.bindingId);
      if (p.schemaVersion !== 1 || p.fingerprint !== sha256Text(canonicalJson({ operationId: p.operationId, target: p.target, scope: p.scope,
        routineId: p.routineId, routineRevision: p.routineRevision, generation: p.generation }))) return pairingFail("store_unavailable");
      if (names.has(p.target.alias) || ids.has(slot.bindingId) || slot.credentialPresent !== (slot.credential !== null)) return pairingFail("store_unavailable");
      if (slot.credential !== null) validatePairingCredential(slot.credential, p);
      if (slot.state === "prepared" && slot.credential === null || ["enrolling", "unbound"].includes(slot.state) && slot.credential !== null) return pairingFail("store_unavailable");
      names.add(p.target.alias); ids.add(slot.bindingId);
    }
    return v;
  }
  async function readFile(file: string) {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat();
      if (!before.isFile() || !privateFile(before) || before.size > OPS_PAIRING_POLICY.maxFileBytes) return pairingFail("store_unavailable");
      const bytes = Buffer.alloc(OPS_PAIRING_POLICY.maxFileBytes + 1); let size = 0;
      while (size < bytes.length) { const r = await handle.read(bytes, size, bytes.length - size, size); if (!r.bytesRead) break; size += r.bytesRead; }
      const after = await handle.stat(), named = await lstat(file);
      if (size !== before.size || size > OPS_PAIRING_POLICY.maxFileBytes || before.dev !== named.dev || before.ino !== named.ino
        || named.isSymbolicLink() || after.size !== before.size || after.ctimeMs !== before.ctimeMs) return pairingFail("store_unavailable");
      return parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size))));
    } finally { await handle.close(); }
  }
  async function read(): Promise<Capsule | null> {
    const existing = await lstat(directory).catch(e => { if (absent(e)) return null; throw e; });
    if (!existing) return null;
    await assertSafeDirectory(directory);
    if ((existing.mode & 0o077) !== 0) return pairingFail("store_unavailable");
    // A lost file inside an existing owner directory is damage, never an empty
    // installation granting another credential request.
    return readFile(path);
  }
  async function publish(value: Capsule) {
    parse(value); const bytes = Buffer.from(canonicalJson(value) + "\n");
    if (bytes.length > OPS_PAIRING_POLICY.maxFileBytes) return pairingFail("capacity");
    const leftover = await lstat(temp).catch(e => { if (absent(e)) return null; throw e; });
    if (leftover) { await readFile(temp); const again = await lstat(temp); if (again.dev !== leftover.dev || again.ino !== leftover.ino) return pairingFail("store_unavailable"); await unlink(temp); }
    const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, path);
    const d = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await d.sync(); } finally { await d.close(); }
  }
  async function mutation<T>(fn: (value: Capsule) => Promise<T>, allowInitialize = false): Promise<T> {
    await assertSafeDirectory(root); const lock = await acquireConfigurationLease(root);
    try {
      let value = await read();
      if (!value) {
        if (!allowInitialize) return pairingFail("not_found");
        await mkdir(directory, { mode: 0o700 });
        value = { schemaVersion: 1, owner: "ops-pairing", rootId, slots: [] }; await publish(value);
      }
      return await fn(value);
    } catch (e) { if (e instanceof OpsPairingError) throw e; return pairingFail("store_unavailable"); }
    finally { await lock.release(); }
  }
  const record = async (alias: string) => {
    pairingAlias(alias);
    try { const slot = (await read())?.slots.find(s => s.plan.target.alias === alias); return slot ? projected(slot) : null; }
    catch { return pairingFail("store_unavailable"); }
  };
  return {
    record,
    /** Only the explicit delivery composition calls this after its outbox start
     * barrier. Credential material never crosses the private-owner boundary.
     * Local revoke wins before this read; a later revoke cannot unsend a POST. */
    sendPreparedNotice: async (expected: PairingRecord, input: { binding: NotificationBinding; body: string; envelopeDigest: string;
      signal: AbortSignal }, request?: NotificationRequest): Promise<NativeNotificationResult> => {
      let enteredTransport = false;
      try {
        const slot = (await read())?.slots.find(s => s.bindingId === expected.bindingId);
        if (!slot || slot.state !== "prepared" || !slot.credential || canonicalJson(projected(slot)) !== canonicalJson(expected))
          return { state: "definitely-not-accepted", reason: "revoked" };
        const b = input.binding, p = slot.plan;
        if (b.bindingId !== slot.bindingId || b.revision !== slot.revision || b.databaseId !== p.scope.databaseId || b.scopeId !== p.scope.scopeId
          || b.targetAlias !== p.target.alias || b.agentId !== p.target.agentId || b.routineKey !== p.target.routineKey
          || b.routineId !== p.routineId || b.policyRevision !== p.target.policyRevision)
          return { state: "definitely-not-accepted", reason: "policy_changed" };
        enteredTransport = true;
        return await sendNativeNotification({ ...input, plan: p, credential: slot.credential }, request);
      } catch { return enteredTransport ? { state: "unknown", reason: "transport_failure" } : { state: "definitely-not-accepted", reason: "revoked" }; }
    },
    status: async (alias?: string) => {
      if (alias) pairingAlias(alias);
      try {
        const value = await read(), slots = value?.slots.filter(s => !alias || s.plan.target.alias === alias) ?? [];
        return { schemaVersion: 1, state: value ? alias && !slots.length ? "not_found" : "observed" : "not_initialized", bindings: slots.map(s => pairingReceipt(projected(s))),
          maxBindings: OPS_PAIRING_POLICY.maxSlots, maxFileBytes: OPS_PAIRING_POLICY.maxFileBytes, maxStagingBytes: OPS_PAIRING_POLICY.maxFileBytes,
          fileBytes: value ? (await lstat(path)).size : null, privateCredentialsIncluded: false, deliveryAuthorized: false, diagnosticGcAllowed: false };
      } catch { return { state: "unavailable", bindings: [], privateCredentialsIncluded: false, deliveryAuthorized: false, fileBytes: null }; }
    },
    reserve: (plan: PairingPlan, expectedBindingRevision: number, current: () => Promise<void>) => mutation(async value => {
      await current(); const prior = value.slots.find(s => s.plan.target.alias === plan.target.alias);
      if (prior?.plan.operationId === plan.operationId) {
        if (prior.plan.fingerprint !== plan.fingerprint) return pairingFail("operation_conflict");
        return { dispatch: false, record: projected(prior) };
      }
      if (prior && prior.state !== "unbound") return pairingFail("pairing_busy");
      if (!Number.isSafeInteger(expectedBindingRevision) || expectedBindingRevision < 0 || (prior?.revision ?? 0) !== expectedBindingRevision) return pairingFail("operation_conflict");
      if (!prior && value.slots.length >= OPS_PAIRING_POLICY.maxSlots) return pairingFail("capacity");
      if (value.slots.some(s => s.state !== "unbound" && s.plan.target.agentId === plan.target.agentId && s.plan.routineId === plan.routineId)) return pairingFail("pairing_busy");
      const slot: Slot = { plan, bindingId: randomUUID(), revision: (prior?.revision ?? 0) + 1,
        state: "enrolling", updatedAtMs: Date.now(), credentialPresent: false, credential: null };
      value.slots = value.slots.filter(s => s.plan.target.alias !== plan.target.alias); value.slots.push(slot); await publish(value);
      return { dispatch: true, record: projected(slot) };
    }, true),
    finish: (record: PairingRecord, credential: PairingCredential, current: () => Promise<void>) => mutation(async value => {
      await current(); const slot = value.slots.find(s => s.bindingId === record.bindingId);
      if (!slot || slot.revision !== record.revision || slot.state !== "enrolling" || slot.plan.fingerprint !== record.plan.fingerprint) return pairingFail("operation_conflict");
      slot.credential = validatePairingCredential(credential, slot.plan); slot.credentialPresent = true;
      slot.state = "prepared"; slot.updatedAtMs = Date.now(); await publish(value); return projected(slot);
    }),
    revoke: (alias: string, revision: number, action: "disable" | "unbind", confirmed: boolean) => mutation(async value => {
      pairingAlias(alias); if (confirmed !== true) return pairingFail("confirmation_required");
      const slot = value.slots.find(s => s.plan.target.alias === alias);
      if (!slot) return pairingFail("not_found");
      if (slot.revision !== revision) return pairingFail("operation_conflict");
      slot.state = action === "disable" ? "disabled" : "unbound"; slot.revision++; slot.updatedAtMs = Date.now();
      if (action === "unbind") { slot.credential = null; slot.credentialPresent = false; }
      await publish(value); return pairingReceipt(projected(slot));
    }),
  };
}
