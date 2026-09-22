import { Effect } from "effect";
import { lstat } from "node:fs/promises";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { ContinuityFailure, continuityEffectIntent, continuityStorePolicy, failContinuity, isContinuityHash, isContinuityUuid,
  DUPLICATION_POLICY_REVISION, duplicateRequest, duplicateInputDigest, duplicateEffectId, duplicateCreated, type DuplicateRequest, type DuplicateCreated,
  recoveryManifest, recoveryRevision, initializeCurrentRequest, initializationDigest, type InitializeCurrentRequest, type ContinuityEffectIntent, type ContinuityStorePolicy, type RecoveryManifest, type RecoveryPublication } from "@grokbox/runtime-kernel/continuity";
import { referenceChange, type ContinuityStorageOwnerId, type ReferenceChange, type ReferenceReceipt, type OwnerMeasurement,
  type OwnedMaintenanceReceipt, type ProtectedStorageRef } from "@grokbox/runtime-kernel/observation";
import type { MonitorSqlite, SqlRow } from "./monitor-sqlite.node.ts";
import { continuityDatabase, continuityIo, type ContinuityStoreHooks } from "./continuity-database.node.ts";
import { blobDigest, checkContinuityFile, continuityFiles, missingFile } from "./continuity-files.node.ts";

export type ContinuityStoreInput = { durableRoot: string; scopeId: string; policy?: Partial<ContinuityStorePolicy> };
type PublicationState = "reserved" | "published" | "abandoned" | "retired";
export type PublicationReceipt = { reference: ProtectedStorageRef; state: PublicationState; quality: string; duplicate: boolean;
  validation: "declared_graph_and_content_hashes"; nativeImportProven: false };
const id = (value: string) => { if (!isContinuityUuid(value)) return failContinuity("invalid_material"); return value; };
const hash = (value: string) => { if (!isContinuityHash(value)) return failContinuity("invalid_material"); return value; };
const total = async (db: MonitorSqlite, sql: string) => Number((await db.first(sql))?.n ?? 0);

/** Production storage programs. No native Bot reads/writes, provider calls or
 * directory imports. A qualified capture adapter must supply material; only
 * the native importer can accept it as a running Bot's current state. */
export function continuityStorePrograms(input: ContinuityStoreInput, hooks: ContinuityStoreHooks = {}) {
  hash(input.scopeId);
  const policy = continuityStorePolicy(input.policy), database = continuityDatabase(input.durableRoot, input.scopeId, policy, hooks);
  const readPolicy = continuityStorePolicy({ maxObjectBytes: 2 * 1024 ** 3, maxSnapshotBytes: 128 * 1024 ** 2,
    maxPartBytes: 64 * 1024 ** 2, maxParts: 1024, maxMetadataBytes: 128 * 1024 ** 2, keepRecent: 16 });
  const files = continuityFiles(database.directory);
  const getPublication = async (db: MonitorSqlite, requestId: string) => {
    const row = await db.first("SELECT * FROM publications WHERE request_id=?", [id(requestId)]);
    if (!row) return failContinuity("not_found"); return row;
  };
  const decode = (row: SqlRow) => {
    if (typeof row.manifest_json !== "string") return failContinuity("not_found");
    let manifest;
    try { manifest = recoveryManifest(JSON.parse(row.manifest_json), readPolicy); }
    catch { return failContinuity("integrity_failure"); }
    if (recoveryRevision(manifest) !== row.digest || manifest.source.scopeId !== input.scopeId || manifest.source.agentId !== row.agent_id || manifest.quality !== row.quality) return failContinuity("integrity_failure");
    return manifest;
  };
  const receipt = (row: SqlRow, duplicate = false): PublicationReceipt => ({ reference: { owner: "continuity.recovery", ref: String(row.request_id), revision: String(row.digest) },
    state: row.state as PublicationState, quality: String(row.quality), duplicate, validation: "declared_graph_and_content_hashes", nativeImportProven: false });
  const verify = async (manifest: RecoveryManifest) => {
    const content = new Map<string, Uint8Array>();
    for (const part of manifest.parts) if (!content.has(part.hash)) content.set(part.hash, await files.read(part.hash, part.bytes));
    return content;
  };
  const commitPublication = async (db: MonitorSqlite, row: SqlRow, manifest: RecoveryManifest) => {
    for (const p of manifest.parts) {
      const prior = await db.first("SELECT bytes FROM objects WHERE hash=?", [p.hash]);
      if (prior && prior.bytes !== p.bytes) return failContinuity("integrity_failure");
      await db.run("INSERT OR IGNORE INTO objects(hash,bytes) VALUES(?,?)", [p.hash, p.bytes]);
    }
    await db.run("UPDATE publications SET state='published',reserved_bytes=0 WHERE request_id=? AND state='reserved'", [String(row.request_id)]);
    return receipt({ ...row, state: "published" });
  };
  const publish = (inputPublication: RecoveryPublication) => Effect.gen(function* () {
    // Freeze caller-owned buffers and metadata before any async suspension.
    const prepared = yield* Effect.try({ try: () => {
      id(inputPublication.requestId); const manifest = recoveryManifest(inputPublication.manifest, policy);
      if (manifest.source.scopeId !== input.scopeId) return failContinuity("scope_mismatch");
      if (!(inputPublication.content instanceof Map)) return failContinuity("invalid_material");
      const content = new Map<string, Uint8Array>();
      for (const p of manifest.parts) {
        if (content.has(p.hash)) continue;
        const original = inputPublication.content.get(p.hash);
        if (!(original instanceof Uint8Array) || original.byteLength !== p.bytes) return failContinuity("invalid_material");
        const bytes = Uint8Array.from(original);
        if (blobDigest(bytes) !== p.hash) return failContinuity("integrity_failure");
        content.set(p.hash, bytes);
      }
      if (content.size !== inputPublication.content.size) return failContinuity("invalid_material");
      return { requestId: inputPublication.requestId, manifest, content, digest: recoveryRevision(manifest) };
    }, catch: e => e instanceof ContinuityFailure ? e : new ContinuityFailure("invalid_material") });
    const { requestId, manifest, content, digest } = prepared;
    const reservation = yield* database.write("reserve-publication", async db => {
      const prior = await db.first("SELECT * FROM publications WHERE request_id=?", [requestId]);
      if (prior) {
        if (prior.digest !== digest) return failContinuity("conflict");
        if (prior.state === "published") await verify(decode(prior));
        return { fresh: false, receipt: receipt(prior, true) };
      }
      const manifestJson = canonicalJson(manifest);
      await database.metadataRoom(db, Buffer.byteLength(manifestJson) * 3 + manifest.parts.length * 256 + 8192);
      const reserved = 2 * [...content.values()].reduce((n, p) => n + p.byteLength, 0);
      const occupied = await total(db, "SELECT COALESCE(SUM(bytes),0) AS n FROM objects")
        + await total(db, "SELECT COALESCE(SUM(reserved_bytes),0) AS n FROM publications WHERE state='reserved'");
      if (occupied + reserved > policy.maxObjectBytes) return failContinuity("capacity");
      await db.run("INSERT INTO publications(request_id,digest,agent_id,quality,manifest_json,state,reserved_bytes,created_at) VALUES(?,?,?,?,?,'reserved',?,?)",
        [requestId, digest, manifest.source.agentId, manifest.quality, manifestJson, reserved, manifest.source.capturedAtMs]);
      for (const [key, bytes] of content) await db.run("INSERT INTO material_links VALUES(?,?,?)", [requestId, key, bytes.byteLength]);
      return { fresh: true, receipt: receipt(await getPublication(db, requestId)) };
    });
    if (!reservation.fresh) return reservation.receipt;
    if (hooks.afterReservation) yield* continuityIo(hooks.afterReservation);
    return yield* database.write("publish-material", async db => {
      const row = await getPublication(db, requestId);
      if (row.digest !== digest) return failContinuity("conflict");
      if (row.state !== "reserved") return receipt(row, true);
      let index = 0;
      for (const [key, bytes] of content) { await files.put(requestId, key, bytes); await hooks.afterObject?.(index++); }
      await verify(manifest);
      return commitPublication(db, row, manifest);
    });
  });
  const reconcilePublication = (requestId: string, action: "verify" | "abandon") => database.write("reconcile-publication", async db => {
    id(requestId); if (!["verify", "abandon"].includes(action)) return failContinuity("invalid_material");
    const row = await getPublication(db, requestId);
    if (row.state === "published") { await verify(decode(row)); return receipt(row, true); }
    if (row.state !== "reserved") return receipt(row, true);
    const manifest = decode(row);
    for (const p of manifest.parts) await files.finishStage(requestId, p.hash);
    if (action === "verify") {
      try { await verify(manifest); } catch (e) { if (missingFile(e)) return receipt(row); throw e; }
      return commitPublication(db, row, manifest);
    }
    // Account for fully linked orphan bytes before releasing the reservation.
    // GC will remove only catalogued, unreferenced objects in a later phase.
    for (const p of manifest.parts) {
      try {
        await files.read(p.hash, p.bytes);
        await db.run("INSERT OR IGNORE INTO objects VALUES(?,?)", [p.hash, p.bytes]);
      } catch (e) { if (!missingFile(e)) throw e; }
    }
    await db.run("DELETE FROM material_links WHERE request_id=?", [requestId]);
    await db.run("UPDATE publications SET state='abandoned',reserved_bytes=0,manifest_json=NULL WHERE request_id=?", [requestId]);
    return receipt({ ...row, state: "abandoned" });
  });
  const readSnapshot = (requestId: string) => database.read(async db => {
    const row = await getPublication(db, requestId);
    if (row.state !== "published") return failContinuity("not_found");
    const manifest = decode(row), content = await verify(manifest);
    return { ...receipt(row), manifest, content };
  });
  const prepareEffect = (raw: ContinuityEffectIntent) => database.write("prepare-effect", async db => {
    const intent = continuityEffectIntent(raw), digest = sha256Text(canonicalJson(intent));
    if (intent.kind === "duplicate") return failContinuity("conflict"); // use the atomic per-source provisioning entry
    const prior = await db.first("SELECT * FROM operations WHERE operation_id=?", [intent.operationId]);
    if (prior) { if (prior.digest !== digest) return failContinuity("conflict"); return operationReceipt(prior, false); }
    if (intent.snapshotId) {
      const row = await getPublication(db, intent.snapshotId);
      if (row.state !== "published") return failContinuity("conflict");
      await verify(decode(row));
    }
    await database.metadataRoom(db, 12288);
    await db.run("INSERT INTO operations(operation_id,digest,intent_json,agent_id,snapshot_id,state,revision,created_at) VALUES(?,?,?,?,?,'prepared',1,?)",
      [intent.operationId, digest, canonicalJson(intent), intent.agentId, intent.snapshotId, Date.now()]);
    return operationReceipt((await db.first("SELECT * FROM operations WHERE operation_id=?", [intent.operationId]))!, false);
  });
  const rememberInitializationRequest = (raw: InitializeCurrentRequest) => database.write("remember-initialization", async db => {
    const request = initializeCurrentRequest(raw), encoded = canonicalJson(request);
    const row = await db.first("SELECT * FROM operations WHERE operation_id=?", [request.operationId]);
    if (!row) return failContinuity("not_found");
    const intent = continuityEffectIntent(JSON.parse(String(row.intent_json)));
    if (intent.kind !== "initialize" || intent.inputDigest !== initializationDigest(request) || intent.agentId !== request.expected.agentId
      || intent.policyRevision !== request.policyRevision || intent.snapshotId !== request.snapshot.ref) return failContinuity("conflict");
    if (row.request_json !== null && row.request_json !== encoded) return failContinuity("conflict");
    if (row.request_json === null) {
      if (row.state !== "prepared") return failContinuity("conflict");
      await database.metadataRoom(db, Buffer.byteLength(encoded) * 2 + 4096);
      await db.run("UPDATE operations SET request_json=? WHERE operation_id=? AND request_json IS NULL", [encoded, request.operationId]);
    }
    return request;
  });
  const initializationRequest = (operationId: string) => database.read(async db => {
    const row = await db.first("SELECT * FROM operations WHERE operation_id=?", [id(operationId)]);
    if (!row || typeof row.request_json !== "string") return failContinuity("not_found");
    try {
      const request = initializeCurrentRequest(JSON.parse(row.request_json));
      const intent = continuityEffectIntent(JSON.parse(String(row.intent_json)));
      if (request.operationId !== operationId || intent.kind !== "initialize" || intent.inputDigest !== initializationDigest(request)
        || intent.agentId !== request.expected.agentId || intent.policyRevision !== request.policyRevision || intent.snapshotId !== request.snapshot.ref) return failContinuity("integrity_failure");
      return request;
    } catch { return failContinuity("integrity_failure"); }
  });
  const operationReceipt = (row: SqlRow, dispatch: boolean) => {
    let intent;
    try { intent = continuityEffectIntent(JSON.parse(String(row.intent_json))); } catch { return failContinuity("integrity_failure"); }
    if (sha256Text(canonicalJson(intent)) !== row.digest || intent.operationId !== row.operation_id || intent.agentId !== row.agent_id || intent.snapshotId !== row.snapshot_id
      || !Number.isSafeInteger(row.revision) || Number(row.revision) < 1 || !["prepared", "effect_unknown", "succeeded", "not_executed"].includes(String(row.state))
      || (row.state === "prepared" ? row.effect_id !== null : !isContinuityUuid(row.effect_id))
      || (["succeeded", "not_executed"].includes(String(row.state)) ? !isContinuityHash(row.evidence_hash) : row.evidence_hash !== null)) return failContinuity("integrity_failure");
    return { operationId: String(row.operation_id), revision: Number(row.revision), state: String(row.state),
    // Safe binding fields support a read-only reconciliation without recapturing
    // source state or re-running an importer. No content is exposed here.
    agentId: intent.agentId, kind: intent.kind, inputDigest: intent.inputDigest, policyRevision: intent.policyRevision, snapshotId: intent.snapshotId,
    effectId: row.effect_id as string | null, evidenceHash: row.evidence_hash as string | null, dispatch,
    // Local durable claim only: the controller must separately validate current
    // authority/policy before dispatch. Restoring a record never grants rights.
    executionAuthorized: false as const, reference: { owner: "continuity.safety" as const, ref: String(row.operation_id), revision: String(row.digest) } };
  };
  const claimEffect = (operationId: string, effectId: string, expectedPolicyRevision: string) => database.write("claim-effect", async db => {
    id(operationId); id(effectId); hash(expectedPolicyRevision);
    const row = await db.first("SELECT * FROM operations WHERE operation_id=?", [operationId]);
    if (!row) return failContinuity("not_found");
    operationReceipt(row, false);
    const intent = continuityEffectIntent(JSON.parse(String(row.intent_json)));
    if (intent.policyRevision !== expectedPolicyRevision) return failContinuity("conflict");
    if (row.state !== "prepared") {
      if (row.effect_id !== effectId) return failContinuity("conflict");
      return operationReceipt(row, false);
    }
    if (intent.snapshotId) {
      const material = await getPublication(db, intent.snapshotId);
      if (material.state !== "published") return failContinuity("integrity_failure");
      await verify(decode(material));
    }
    await database.metadataRoom(db, 4096);
    if (await db.first("SELECT operation_id FROM operations WHERE effect_id=?", [effectId])) return failContinuity("conflict");
    await db.run("UPDATE operations SET state='effect_unknown',effect_id=?,revision=revision+1 WHERE operation_id=?", [effectId, operationId]);
    return operationReceipt({ ...row, state: "effect_unknown", effect_id: effectId, revision: Number(row.revision) + 1 }, true);
  });
  const settleEffect = (operationId: string, effectId: string, outcome: "succeeded" | "not_executed", evidenceHash: string) => database.write("settle-effect", async db => {
    id(operationId); id(effectId); hash(evidenceHash);
    if (!["succeeded", "not_executed"].includes(outcome)) return failContinuity("invalid_material");
    const row = await db.first("SELECT * FROM operations WHERE operation_id=?", [operationId]);
    if (!row) return failContinuity("not_found");
    if (row.effect_id !== effectId || row.state === "prepared") return failContinuity("conflict");
    if (outcome === "succeeded" && continuityEffectIntent(JSON.parse(String(row.intent_json))).kind === "duplicate") return failContinuity("conflict");
    if (row.state !== "effect_unknown") {
      if (row.state !== outcome || row.evidence_hash !== evidenceHash) return failContinuity("conflict");
      return operationReceipt(row, false);
    }
    await db.run("UPDATE operations SET state=?,evidence_hash=?,revision=revision+1 WHERE operation_id=?", [outcome, evidenceHash, operationId]);
    return operationReceipt({ ...row, state: outcome, evidence_hash: evidenceHash, revision: Number(row.revision) + 1 }, false);
  });
  const decodeDuplication = (row: SqlRow) => {
    const operation = operationReceipt(row, false);
    try {
      const request = duplicateRequest(JSON.parse(String(row.request_json)));
      if (operation.kind !== "duplicate" || request.operationId !== operation.operationId || request.source.agentId !== operation.agentId
        || request.source.scopeId !== input.scopeId || duplicateInputDigest(request) !== operation.inputDigest
        || operation.policyRevision !== DUPLICATION_POLICY_REVISION || operation.snapshotId !== null) return failContinuity("integrity_failure");
      const result = row.result_json === null ? null : duplicateCreated(JSON.parse(String(row.result_json)), request);
      if ((operation.state === "succeeded") !== (result !== null)
        || result && operation.evidenceHash !== sha256Text(canonicalJson(result))) return failContinuity("integrity_failure");
      return { request, operation, result };
    } catch { return failContinuity("integrity_failure"); }
  };
  const prepareDuplication = (raw: DuplicateRequest) => database.write("prepare-duplication", async db => {
    const request = duplicateRequest(raw);
    if (request.source.scopeId !== input.scopeId) return failContinuity("scope_mismatch");
    const prior = await db.first("SELECT * FROM operations WHERE operation_id=?", [request.operationId]);
    if (prior) {
      const saved = decodeDuplication(prior);
      if (saved.request.planRevision !== request.planRevision || saved.request.source.agentId !== request.source.agentId
        || saved.request.source.scopeId !== request.source.scopeId) return failContinuity("conflict");
      return saved;
    }
    // Different operation IDs must not bypass an unresolved native creation.
    // This is a per-source guard, not a global Bot lock or remote idempotency.
    const active = await db.first("SELECT operation_id FROM operations WHERE agent_id=? AND state IN ('prepared','effect_unknown') AND json_extract(intent_json,'$.kind')='duplicate' LIMIT 1", [request.source.agentId]);
    if (active) return failContinuity("busy");
    const intent = continuityEffectIntent({ operationId: request.operationId, agentId: request.source.agentId, kind: "duplicate",
      inputDigest: duplicateInputDigest(request), policyRevision: DUPLICATION_POLICY_REVISION, snapshotId: null });
    await database.metadataRoom(db, 16384);
    await db.run("INSERT INTO operations(operation_id,digest,intent_json,agent_id,snapshot_id,state,revision,created_at,request_json) VALUES(?,?,?,?,NULL,'prepared',1,?,?)",
      [intent.operationId, sha256Text(canonicalJson(intent)), canonicalJson(intent), intent.agentId, Date.now(), canonicalJson(request)]);
    return decodeDuplication((await db.first("SELECT * FROM operations WHERE operation_id=?", [request.operationId]))!);
  });
  const recordDuplication = (raw: DuplicateCreated) => database.write("record-duplication", async db => {
    const row = await db.first("SELECT * FROM operations WHERE operation_id=?", [id(raw.operationId)]);
    if (!row) return failContinuity("not_found");
    const saved = decodeDuplication(row), result = duplicateCreated(raw, saved.request), encoded = canonicalJson(result);
    if (saved.result) {
      if (canonicalJson(saved.result) !== encoded) return failContinuity("conflict");
      return saved;
    }
    if (saved.operation.state !== "effect_unknown" || saved.operation.effectId !== duplicateEffectId(result.operationId)) return failContinuity("conflict");
    await database.metadataRoom(db, 4096);
    const evidenceHash = sha256Text(encoded);
    await db.run("UPDATE operations SET result_json=?,state='succeeded',evidence_hash=?,revision=revision+1 WHERE operation_id=?",
      [encoded, evidenceHash, result.operationId]);
    return decodeDuplication({ ...row, result_json: encoded, state: "succeeded", evidence_hash: evidenceHash, revision: Number(row.revision) + 1 });
  });
  const stopUnclaimedDuplication = (operationId: string) => database.write("stop-unclaimed-duplication", async db => {
    const row = await db.first("SELECT * FROM operations WHERE operation_id=?", [id(operationId)]);
    if (!row) return failContinuity("not_found");
    const saved = decodeDuplication(row);
    if (saved.operation.state !== "prepared") return saved;
    const effectId = duplicateEffectId(operationId), evidenceHash = sha256Text("native-duplicate:plan-changed-before-claim");
    await db.run("UPDATE operations SET state='not_executed',effect_id=?,evidence_hash=?,revision=revision+1 WHERE operation_id=?",
      [effectId, evidenceHash, operationId]);
    return decodeDuplication({ ...row, state: "not_executed", effect_id: effectId, evidence_hash: evidenceHash, revision: Number(row.revision) + 1 });
  });
  const duplication = (operationId: string) => database.read(async db => {
    const row = await db.first("SELECT * FROM operations WHERE operation_id=?", [id(operationId)]);
    if (!row) return failContinuity("not_found");
    return decodeDuplication(row);
  });
  const changeReference = (owner: ContinuityStorageOwnerId, raw: ReferenceChange) => database.write("reference-change", async db => {
    const change = referenceChange(raw);
    if (change.reference.owner !== owner) return failContinuity("conflict");
    const digest = sha256Text(canonicalJson(change));
    const reply = (state: ReferenceReceipt["state"], blockedBy: ReferenceReceipt["blockedBy"] = []): ReferenceReceipt => ({ state, blockedBy,
      requestId: change.requestId, claimId: change.claimId, reference: change.reference });
    const prior = await db.first("SELECT * FROM reference_requests WHERE request_id=?", [change.requestId]);
    const claim = await db.first("SELECT * FROM claims WHERE owner=? AND claim_id=?", [owner, change.claimId]);
    if (prior) {
      if (prior.digest !== digest) return reply("conflict", ["conflict"]);
      const recorded = JSON.parse(String(prior.receipt_json)) as ReferenceReceipt;
      // A repeated protect receipt must not assert a claim that was released.
      if (recorded.state === "protected" && (!claim || claim.active !== 1 || claim.ref !== change.reference.ref || claim.revision !== change.reference.revision)) return reply("conflict", ["conflict"]);
      return recorded;
    }
    const row = owner === "continuity.recovery"
      ? await db.first("SELECT digest,state FROM publications WHERE request_id=?", [change.reference.ref])
      : await db.first("SELECT digest,state FROM operations WHERE operation_id=?", [change.reference.ref]);
    if (!row || row.digest !== change.reference.revision || owner === "continuity.recovery" && row.state !== "published") return reply("conflict", ["conflict"]);
    if (claim && (claim.ref !== change.reference.ref || claim.revision !== change.reference.revision || change.action === "protect" && claim.active !== 1)) return reply("conflict", ["conflict"]);
    await database.metadataRoom(db, 8192);
    if (change.action === "protect") {
      if (owner === "continuity.recovery") await verify(decode(await getPublication(db, change.reference.ref)));
      await db.run("INSERT OR IGNORE INTO claims VALUES(?,?,?,?,1)", [owner, change.claimId, change.reference.ref, change.reference.revision]);
    } else {
      // Retain a minimal released-claim tombstone. Reusing a claim ID cannot
      // allow an old release request to remove a newer protection.
      await db.run("INSERT INTO claims VALUES(?,?,?,?,0) ON CONFLICT(owner,claim_id) DO UPDATE SET active=0", [owner, change.claimId, change.reference.ref, change.reference.revision]);
    }
    // Store only the strict public receipt, not the request's action field.
    const result: ReferenceReceipt = { requestId: change.requestId, claimId: change.claimId, reference: change.reference,
      state: change.action === "protect" ? "protected" : "released", blockedBy: [] };
    await db.run("INSERT INTO reference_requests VALUES(?,?,?)", [change.requestId, digest, canonicalJson(result)]);
    return result;
  });
  const maintainRecovery = (nowMs: number, maxItems: number) => Effect.gen(function* () {
    if (!Number.isSafeInteger(nowMs) || nowMs < 1 || !Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > 64) return yield* Effect.fail(new ContinuityFailure("invalid_material"));
    // First retire metadata durably. File reclamation is a separate phase:
    // rollback after unlink can never resurrect a published snapshot reference.
    yield* database.write("retire-snapshots", async db => {
      const candidates = await db.all(`SELECT p.* FROM publications p WHERE p.state='published'
        AND (SELECT COUNT(*) FROM publications n WHERE n.agent_id=p.agent_id AND n.state='published'
          AND (n.created_at>p.created_at OR (n.created_at=p.created_at AND n.sequence>=p.sequence)))>?
        AND NOT (p.quality='native_checkpoint' AND NOT EXISTS(SELECT 1 FROM publications n WHERE n.agent_id=p.agent_id AND n.state='published'
          AND n.quality='native_checkpoint' AND (n.created_at>p.created_at OR (n.created_at=p.created_at AND n.sequence>p.sequence))))
        AND NOT EXISTS(SELECT 1 FROM claims c WHERE c.owner='continuity.recovery' AND c.active=1 AND c.ref=p.request_id AND c.revision=p.digest)
        AND NOT EXISTS(SELECT 1 FROM operations o WHERE o.snapshot_id=p.request_id AND o.state IN ('prepared','effect_unknown'))
        AND NOT EXISTS(SELECT 1 FROM continuity_workflow_materials r JOIN continuity_workflows w ON w.operation_id=r.operation_id
          WHERE r.snapshot_id=p.request_id AND w.phase<>'retired')
        AND NOT EXISTS(SELECT 1 FROM continuity_subject_materials r WHERE r.snapshot_id=p.request_id)
        AND NOT EXISTS(SELECT 1 FROM continuity_queued_controls c, json_each(c.request_json,'$.materialIds') r
          WHERE c.kind='managed-current-state' AND r.value=p.request_id
            AND json_extract(c.result_json,'$.disposition') IS NOT 'cancelled-before-source-application' AND
            (c.state<>'complete' OR (json_extract(c.request_json,'$.declaration.action')<>'capture' AND NOT EXISTS
              (SELECT 1 FROM continuity_queued_controls a WHERE a.operation_id=json_extract(c.request_json,'$.activationId')
                AND a.kind='managed-current-release' AND a.state='complete'))))
        AND NOT EXISTS(
          SELECT 1 FROM continuity_queued_controls c
          WHERE c.kind='self-reset' AND c.state IN ('queued','effect_unknown','blocked','unknown')
            AND (
              EXISTS(SELECT 1 FROM json_each(c.request_json,'$.materialRefs') r WHERE json_extract(r.value,'$.ref')=p.request_id)
              OR EXISTS(SELECT 1 FROM json_each(c.request_json,'$.duties') d
                JOIN json_each(d.value,'$.materialRefs') r WHERE json_extract(r.value,'$.ref')=p.request_id)
              OR EXISTS(SELECT 1 FROM json_each(c.result_json,'$.duties') d
                JOIN json_each(d.value,'$.materialRefs') r WHERE json_extract(r.value,'$.ref')=p.request_id)
              OR EXISTS(SELECT 1 FROM json_each(c.request_json,'$.workflowRefs') r
                JOIN continuity_workflow_materials m ON m.operation_id=json_extract(r.value,'$.operationId')
                WHERE m.snapshot_id=p.request_id)
            )
        )
        ORDER BY p.sequence LIMIT ?`, [policy.keepRecent, maxItems]);
      // One subject per finite pass. Revalidate the retained points before
      // discarding older fallback material; corrupt newest bytes are not a
      // reason to erase the last readable older snapshot.
      const agent = candidates[0]?.agent_id;
      if (agent) {
        const retained = await db.all("SELECT * FROM publications WHERE agent_id=? AND state='published' ORDER BY created_at DESC,sequence DESC LIMIT ?", [String(agent), policy.keepRecent]);
        const native = await db.first("SELECT * FROM publications WHERE agent_id=? AND state='published' AND quality='native_checkpoint' ORDER BY created_at DESC,sequence DESC LIMIT 1", [String(agent)]);
        if (native && !retained.some(r => r.request_id === native.request_id)) retained.push(native);
        for (const row of retained) await verify(decode(row));
      }
      for (const row of candidates.filter(r => r.agent_id === agent)) {
        await db.run("DELETE FROM material_links WHERE request_id=?", [String(row.request_id)]);
        await db.run("UPDATE publications SET state='retired',manifest_json=NULL WHERE request_id=?", [String(row.request_id)]);
      }
    });
    return yield* database.write("reclaim-objects", async db => {
      const unused = await db.all("SELECT * FROM objects o WHERE NOT EXISTS(SELECT 1 FROM material_links l WHERE l.hash=o.hash) LIMIT ?", [maxItems]);
      let reclaimedBytes = 0;
      for (const row of unused) {
        reclaimedBytes += await files.remove(String(row.hash));
        await db.run("DELETE FROM objects WHERE hash=?", [String(row.hash)]);
      }
      const unknown = await total(db, "SELECT COUNT(*) AS n FROM operations WHERE state='effect_unknown'");
      const protectedCount = await total(db, "SELECT COUNT(*) AS n FROM claims WHERE owner='continuity.recovery' AND active=1");
      return { owner: "continuity.recovery", state: "maintained", reclaimedBytes,
        blockedBy: [...(protectedCount ? ["active_reference" as const] : []), "last_reliable_point" as const, ...(unknown ? ["effect_unknown" as const] : [])] } satisfies OwnedMaintenanceReceipt;
    });
  });
  const measure = (owner: ContinuityStorageOwnerId) => database.read(async db => {
    if (owner === "continuity.safety") {
      const allocations = [];
      for (const path of [database.file, database.file + "-journal"]) { const a = await files.allocation(path); if (a) allocations.push(a); }
      const info = await checkContinuityFile(database.file), bytes = info!.size;
      const unknown = await total(db, "SELECT COUNT(*) AS n FROM operations WHERE state='effect_unknown'");
      return { owner, observedAtMs: Date.now(), coverage: "complete", logicalBytes: bytes, protectedLogicalBytes: bytes, reclaimableLogicalBytes: 0,
        allocations, blockedBy: unknown ? ["effect_unknown"] : ["unsupported"] } satisfies OwnerMeasurement;
    }
    const rows = await db.all(`SELECT o.hash,o.bytes,EXISTS(SELECT 1 FROM material_links l WHERE l.hash=o.hash) AS protected FROM objects o ORDER BY o.hash LIMIT 257`);
    let logicalBytes = 0, protectedBytes = 0, reclaimed = 0, allocationBytes = 0;
    for (const row of rows.slice(0, 256)) {
      const st = await checkContinuityFile(files.objectPath(String(row.hash)));
      if (st!.size !== row.bytes) return failContinuity("integrity_failure");
      logicalBytes += st!.size; allocationBytes += st!.blocks * 512;
      if (row.protected) protectedBytes += st!.size; else reclaimed += st!.size;
    }
    const reservations = await total(db, "SELECT COUNT(*) AS n FROM publications WHERE state='reserved'");
    const directory = await lstat(files.objects);
    return { owner, observedAtMs: Date.now(), coverage: rows.length > 256 || reservations ? "partial" : "complete", logicalBytes,
      protectedLogicalBytes: protectedBytes, reclaimableLogicalBytes: reclaimed,
      allocations: [{ allocationId: sha256Text(`continuity-objects:${directory.dev}:${directory.ino}`), allocatedBytes: allocationBytes + directory.blocks * 512 }],
      blockedBy: reservations ? ["active_reference", "unavailable"] : ["last_reliable_point"] } satisfies OwnerMeasurement;
  });
  const maintainSafety = () => database.read(async db => ({ owner: "continuity.safety", state: "blocked", reclaimedBytes: 0,
    blockedBy: await total(db, "SELECT COUNT(*) AS n FROM operations WHERE state='effect_unknown'") ? ["effect_unknown"] : ["unsupported"] } satisfies OwnedMaintenanceReceipt));
  return { initialize: database.initialize, publish, reconcilePublication, readSnapshot, prepareDuplication, recordDuplication, stopUnclaimedDuplication, duplication, prepareEffect, rememberInitializationRequest, initializationRequest, claimEffect, settleEffect, changeReference, measure, maintainRecovery, maintainSafety,
    latestSnapshot: (agentId: string) => database.read(async db => {
      id(agentId);
      const row = await db.first("SELECT * FROM publications WHERE agent_id=? AND state='published' ORDER BY sequence DESC LIMIT 1", [agentId]);
      if (!row) return null;
      const manifest = decode(row); await verify(manifest);
      return { ...receipt(row), requestId: String(row.request_id) };
    }),
    publication: (requestId: string) => database.read(async db => receipt(await getPublication(db, requestId))),
    operation: (operationId: string) => database.read(async db => {
      const row = await db.first("SELECT * FROM operations WHERE operation_id=?", [id(operationId)]);
      if (!row) return failContinuity("not_found"); return operationReceipt(row, false);
    }),
    status: () => database.read(async db => ({ schemaVersion: 1, materialScope: "declared_private_material", nativeImportProven: false, executionAuthorized: false,
      publications: await db.all("SELECT state,COUNT(*) AS count FROM publications GROUP BY state"),
      operations: await db.all("SELECT state,COUNT(*) AS count FROM operations GROUP BY state"),
      objectBytes: await total(db, "SELECT COALESCE(SUM(bytes),0) AS n FROM objects"),
      reservedBytes: await total(db, "SELECT COALESCE(SUM(reserved_bytes),0) AS n FROM publications WHERE state='reserved'"),
      metadataBytes: (await checkContinuityFile(database.file))!.size, limits: policy,
      safetyRetirement: "not_qualified", installationBudgetEnforced: false })),
  };
}
