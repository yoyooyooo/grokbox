import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { OpsPairingError, OPS_PAIRING_POLICY, pairingFail, pairingAlias, pairingOperation, pairingReceipt, pairingScope, validatePairingCredential,
  validateNotificationTarget, validateNoticeAuthorization, validateReceiverManagementReceipt, type ReceiverManagementReceipt, type NoticeAuthorization, type PairingRecord, type PairingPlan, type PairingCredential, type NotificationBinding, type NativeNotificationResult } from "@grokbox/runtime-kernel/observation";
import { routineAgentId, routineId, routineRevision } from "@grokbox/runtime-kernel/routines";
import { acquireConfigurationLease } from "./config-lock.node.ts";
import { assertSafeDirectory } from "./config-layout.node.ts";
import { sendNativeNotification, type NotificationRequest } from "./native-notification.node.ts";

type Slot = PairingRecord & { credential: PairingCredential | null };
export type PairingManagementIdentity = { operationId: string; requestDigest: string; databaseId: string; agentId: string };
export type PairingManagementReceipt = PairingManagementIdentity & { bindingId: string; alias: string; routineId: string;
  beforeRevision: number; revision: number; state: "unknown" | "succeeded" };
type Capsule = { schemaVersion: 1; owner: "ops-pairing"; rootId: string; slots: Slot[]; operations?: ReceiverManagementReceipt[]; pairingOperations?: PairingManagementReceipt[] };
export type ReceiverMutationIdentity = { operationId: string; requestDigest: string; bindingId: string };
const NEW_GRANT_RECEIPTS = 64;
// Reserve two revocations per slot (disable then unbind). A full ordinary
// audit budget must not trap an enabled receiver in continued authorization.
const MAX_RECEIVER_OPERATIONS = NEW_GRANT_RECEIPTS + 2 * OPS_PAIRING_POLICY.maxSlots;
const REVOCATION_RESERVED_BYTES = 2 * OPS_PAIRING_POLICY.maxSlots * 1024;
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
    if (v.operations !== undefined && (!Array.isArray(v.operations) || v.operations.length > MAX_RECEIVER_OPERATIONS
      || new Set(v.operations.map(row => validateReceiverManagementReceipt(row).operationId)).size !== v.operations.length)) return pairingFail("store_unavailable");
    if (v.pairingOperations !== undefined) {
      if (!Array.isArray(v.pairingOperations) || v.pairingOperations.length > 64 || new Set(v.pairingOperations.map(row => row.operationId)).size !== v.pairingOperations.length) return pairingFail("store_unavailable");
      for (const row of v.pairingOperations) {
        if (!row || Object.keys(row).some(k => !["operationId","requestDigest","databaseId","agentId","bindingId","alias","routineId","beforeRevision","revision","state"].includes(k))
          || !["unknown", "succeeded"].includes(row.state) || !Number.isSafeInteger(row.beforeRevision) || row.beforeRevision < 0 || row.revision !== row.beforeRevision + 1) return pairingFail("store_unavailable");
        pairingOperation(row.operationId); routineRevision(row.requestDigest); routineAgentId(row.databaseId); routineAgentId(row.agentId); routineAgentId(row.bindingId); pairingAlias(row.alias); routineId(row.routineId);
      }
    }
    const names = new Set<string>(), ids = new Set<string>();
    for (const slot of v.slots) {
      if (!slot || !slot.plan || !["enrolling", "prepared", "disabled", "unbound"].includes(slot.state)
        || !Number.isSafeInteger(slot.revision) || slot.revision < 1 || !Number.isSafeInteger(slot.updatedAtMs) || slot.updatedAtMs < 1) return pairingFail("store_unavailable");
      const p = slot.plan; pairingOperation(p.operationId); pairingScope(p.scope); validateNotificationTarget(p.target); routineId(p.routineId); routineRevision(p.routineRevision); routineRevision(p.generation); routineAgentId(slot.bindingId);
      if (p.schemaVersion !== 1 || p.fingerprint !== sha256Text(canonicalJson({ operationId: p.operationId, target: p.target, scope: p.scope,
        routineId: p.routineId, routineRevision: p.routineRevision, generation: p.generation }))) return pairingFail("store_unavailable");
      if (names.has(p.target.alias) || ids.has(slot.bindingId) || slot.credentialPresent !== (slot.credential !== null)) return pairingFail("store_unavailable");
      if (slot.automatic !== undefined) {
        validateNoticeAuthorization(slot.automatic);
        if (slot.state !== "prepared" || slot.automatic.bindingRevision !== slot.revision) return pairingFail("store_unavailable");
      }
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
  async function publish(value: Capsule, reserveRevocations = true) {
    parse(value); const bytes = Buffer.from(canonicalJson(value) + "\n");
    if (bytes.length > OPS_PAIRING_POLICY.maxFileBytes - (reserveRevocations ? REVOCATION_RESERVED_BYTES : 0)) return pairingFail("capacity");
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
  const lookup = async (operationId: string) => {
    pairingOperation(operationId);
    return (await read())?.operations?.find(row => row.operationId === operationId) ?? null;
  };
  function priorOperation(value: Capsule, identity: ReceiverMutationIdentity, action: "enable" | "disable" | "unbind"): ReceiverManagementReceipt | null {
    pairingOperation(identity.operationId); routineAgentId(identity.bindingId); routineRevision(identity.requestDigest);
    const prior = value.operations?.find(row => row.operationId === identity.operationId);
    if (prior && (prior.requestDigest !== identity.requestDigest || prior.bindingId !== identity.bindingId)) return pairingFail("operation_conflict");
    if (!prior && (value.operations?.length ?? 0) >= (action === "enable" ? NEW_GRANT_RECEIPTS : MAX_RECEIVER_OPERATIONS)) return pairingFail("capacity");
    return prior ?? null;
  }
  function recordOperation(value: Capsule, slot: Slot, identity: ReceiverMutationIdentity, action: ReceiverManagementReceipt["action"]) {
    if (slot.bindingId !== identity.bindingId) return pairingFail("operation_conflict");
    const receipt = validateReceiverManagementReceipt({ version: 1, operationId: identity.operationId, requestDigest: identity.requestDigest,
      alias: slot.plan.target.alias, bindingId: slot.bindingId, action, beforeRevision: slot.revision - 1, appliedRevision: slot.revision,
      appliedAtMs: slot.updatedAtMs, authorizationId: action === "enable" ? slot.automatic?.id : null, state: "succeeded" });
    (value.operations ??= []).push(receipt);
    return receipt;
  }
  return {
    record, managementReceipt: lookup,
    pairingOperation: async (operationId: string): Promise<PairingManagementReceipt | null> => {
      pairingOperation(operationId);
      const row = (await read())?.pairingOperations?.find(row => row.operationId === operationId);
      return row ? structuredClone(row) : null;
    },
    records: async () => ((await read())?.slots ?? []).map(projected),
    /** Only the explicit delivery composition calls this after its outbox start
     * barrier. Credential material never crosses the private-owner boundary.
     * Local revoke wins before this read; a later revoke cannot unsend a POST. */
    sendPreparedNotice: async (expected: PairingRecord, input: { binding: NotificationBinding; body: string; envelopeDigest: string;
      signal: AbortSignal }, request?: NotificationRequest, authorizationId?: string,
      authorize?: (signal: AbortSignal) => Promise<void>): Promise<NativeNotificationResult> => {
      let enteredTransport = false;
      try {
        const slot = (await read())?.slots.find(s => s.bindingId === expected.bindingId);
        if (!slot || slot.state !== "prepared" || !slot.credential || canonicalJson(projected(slot)) !== canonicalJson(expected))
          return { state: "definitely-not-accepted", reason: "revoked" };
        if (authorizationId && (!slot.automatic || slot.automatic.id !== authorizationId
          || slot.automatic.bindingRevision !== slot.revision || slot.automatic.modelRevision !== input.binding.modelRevision
          || slot.automatic.qualificationRevision !== input.binding.qualificationRevision)) return { state: "definitely-not-accepted", reason: "revoked" };
        const b = input.binding, p = slot.plan;
        if (b.bindingId !== slot.bindingId || b.revision !== slot.revision || b.databaseId !== p.scope.databaseId || b.scopeId !== p.scope.scopeId
          || b.targetAlias !== p.target.alias || b.agentId !== p.target.agentId || b.routineKey !== p.target.routineKey
          || b.routineId !== p.routineId || b.policyRevision !== p.target.policyRevision)
          return { state: "definitely-not-accepted", reason: "policy_changed" };
        // Management grants are checked again after the durable start and the
        // private credential read, immediately before entering native transport.
        // A denial here is known zero HTTP, not an uncertain network failure.
        if (authorize) await authorize(input.signal);
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
    reserve: (plan: PairingPlan, expectedBindingRevision: number, current: () => Promise<void>, management?: PairingManagementIdentity) => mutation(async value => {
      if (management) {
        pairingOperation(management.operationId); routineRevision(management.requestDigest);
        if (management.operationId !== plan.operationId || management.databaseId !== plan.scope.databaseId || management.agentId !== plan.target.agentId) return pairingFail("scope_changed");
        const old = value.pairingOperations?.find(row => row.operationId === management.operationId);
        if (old && old.requestDigest !== management.requestDigest) return pairingFail("operation_conflict");
        if (!old && (value.pairingOperations?.length ?? 0) >= 64) return pairingFail("capacity");
      }
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
      value.slots = value.slots.filter(s => s.plan.target.alias !== plan.target.alias); value.slots.push(slot);
      if (management) (value.pairingOperations ??= []).push({ ...management, bindingId: slot.bindingId, alias: plan.target.alias,
        routineId: plan.routineId, beforeRevision: expectedBindingRevision, revision: slot.revision, state: "unknown" });
      await publish(value);
      return { dispatch: true, record: projected(slot) };
    }, true),
    finish: (record: PairingRecord, credential: PairingCredential, current: () => Promise<void>) => mutation(async value => {
      await current(); const slot = value.slots.find(s => s.bindingId === record.bindingId);
      if (!slot || slot.revision !== record.revision || slot.state !== "enrolling" || slot.plan.fingerprint !== record.plan.fingerprint) return pairingFail("operation_conflict");
      slot.credential = validatePairingCredential(credential, slot.plan); slot.credentialPresent = true;
      slot.state = "prepared"; slot.updatedAtMs = Date.now();
      const managed = value.pairingOperations?.find(row => row.operationId === record.plan.operationId && row.bindingId === record.bindingId);
      if (managed) managed.state = "succeeded";
      await publish(value); return projected(slot);
    }),
    authorizeAutomatic: (expected: PairingRecord, authorization: NoticeAuthorization, current: () => Promise<void>, identity?: ReceiverMutationIdentity) => mutation(async value => {
      validateNoticeAuthorization(authorization);
      const slot = value.slots.find(s => s.bindingId === expected.bindingId);
      if (identity) {
        const prior = priorOperation(value, identity, "enable");
        if (prior) return slot ? projected(slot) : pairingFail("not_found");
      }
      if (!slot || !["prepared", "disabled"].includes(slot.state) || !slot.credential) return pairingFail("not_found");
      if (slot.automatic?.operationId === authorization.operationId) {
        if (slot.automatic.requestDigest !== authorization.requestDigest) return pairingFail("operation_conflict");
        return projected(slot);
      }
      if (slot.automatic || canonicalJson(projected(slot)) !== canonicalJson(expected)
        || authorization.bindingRevision !== slot.revision + 1) return pairingFail("operation_conflict");
      await current();
      slot.revision = authorization.bindingRevision; slot.state = "prepared"; slot.automatic = authorization; slot.updatedAtMs = authorization.activatedAtMs;
      if (identity) recordOperation(value, slot, identity, "enable");
      await publish(value); return projected(slot);
    }),
    revoke: (alias: string, revision: number, action: "disable" | "unbind", confirmed: boolean, identity?: ReceiverMutationIdentity) => mutation(async value => {
      pairingAlias(alias); if (confirmed !== true) return pairingFail("confirmation_required");
      if (identity) {
        const prior = priorOperation(value, identity, action);
        if (prior) return prior;
      }
      const slot = value.slots.find(s => s.plan.target.alias === alias);
      if (!slot) return pairingFail("not_found");
      if (slot.revision !== revision || revision >= Number.MAX_SAFE_INTEGER || (identity && slot.bindingId !== identity.bindingId)) return pairingFail("operation_conflict");
      if (identity && (slot.state === "unbound" || action === "disable" && slot.state === "disabled")) return pairingFail("operation_conflict");
      slot.state = action === "disable" ? "disabled" : "unbound"; slot.revision++; slot.updatedAtMs = Date.now(); delete slot.automatic;
      if (action === "unbind") { slot.credential = null; slot.credentialPresent = false; }
      const receipt = identity ? recordOperation(value, slot, identity, action) : pairingReceipt(projected(slot));
      await publish(value, false); return receipt;
    }),
  };
}
