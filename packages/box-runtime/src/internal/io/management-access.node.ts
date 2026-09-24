import { join } from "node:path";
import { Effect } from "effect";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { ConfigError, isObject } from "@grokbox/runtime-kernel/config";
import type { ManagedAccessGrant, AccessChange, AccessReceipt, AccessView } from "@grokbox/runtime-kernel/management-access";
import { readConfigFile, publishConfigFile, readInstallation } from "./config-layout.node.ts";
import { acquireConfigurationLease } from "./config-lock.node.ts";
type AccessState = { schemaVersion: 1; installationId: string; grants: ManagedAccessGrant[];
  operations: Record<string, { fingerprint: string; receipt: AccessReceipt }> };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sha = /^[0-9a-f]{64}$/;
function invalid(): never { throw new ConfigError("config_invalid", "Management access policy is invalid."); }
function grant(value: unknown): value is ManagedAccessGrant {
  return isObject(value) && Object.keys(value).length === 4 && typeof value.grantId === "string" && uuid.test(value.grantId)
    && typeof value.principalId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(value.principalId) && value.principalId !== "installation-owner"
    && typeof value.tokenSha256 === "string" && sha.test(value.tokenSha256) && Array.isArray(value.capabilities) && value.capabilities.length <= 128
    && value.capabilities.every(capability => typeof capability === "string" && /^[a-z][a-z.-]{0,63}$/.test(capability))
    && new Set(value.capabilities).size === value.capabilities.length
    && !value.capabilities.some(capability => ["system.config.write", "system.integration.write", "system.access.write", "models.credentials.import", "console.grants.create"].includes(capability));
}
export function openManagementAccess(root: string, installationId: string) {
  const path = join(root, "state", "management-access.json");
  const read = async (): Promise<AccessState> => {
    const value = await readConfigFile(path, true);
    if (value === undefined) return { schemaVersion: 1, installationId, grants: [], operations: {} };
    if (!isObject(value) || Object.keys(value).length !== 4 || value.schemaVersion !== 1 || value.installationId !== installationId
      || !Array.isArray(value.grants) || value.grants.length > 63 || !value.grants.every(grant)
      || new Set(value.grants.map(item => item.grantId)).size !== value.grants.length
      || new Set(value.grants.map(item => item.tokenSha256)).size !== value.grants.length
      || !isObject(value.operations) || Object.keys(value.operations).length > 256) invalid();
    const operations: AccessState["operations"] = {};
    for (const [id, operation] of Object.entries(value.operations)) {
      if (!uuid.test(id) || !isObject(operation) || Object.keys(operation).length !== 2
        || typeof operation.fingerprint !== "string" || !sha.test(operation.fingerprint) || !isObject(operation.receipt)) invalid();
      const receipt = operation.receipt;
      if (Object.keys(receipt).length !== 5 || receipt.requestId !== id || typeof receipt.revision !== "string" || !sha.test(receipt.revision)
        || (receipt.action !== "grant" && receipt.action !== "revoke") || typeof receipt.grantId !== "string" || !uuid.test(receipt.grantId) || receipt.committed !== true) invalid();
      operations[id] = { fingerprint: operation.fingerprint, receipt: { requestId: id, revision: receipt.revision, action: receipt.action, grantId: receipt.grantId, committed: true } };
    }
    return { schemaVersion: 1, installationId, grants: value.grants, operations };
  };
  const revision = (state: AccessState) => sha256Text(canonicalJson({ installationId, grants: state.grants }));
  return {
    grants: async () => (await read()).grants,
    view: async (): Promise<AccessView> => {
      const current = await read();
      return { revision: revision(current), grants: current.grants.map(({ tokenSha256: _secret, ...item }) => item), ownerRevocable: false };
    },
    receipt: async (id: string) => (await read()).operations[id]?.receipt,
    change: (request: AccessChange, authorize: () => Promise<void>) => Effect.gen(function* () {
      if (!uuid.test(request.requestId) || !sha.test(request.expectedRevision) || request.confirmed !== true
        || (request.action === "grant" ? !grant(request.grant) : request.action !== "revoke" || !uuid.test(request.grantId))) invalid();
      const fingerprint = sha256Text(canonicalJson(request));
      const attempt = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: error => error });
      return yield* Effect.acquireUseRelease(attempt(() => acquireConfigurationLease(root)), () => Effect.gen(function* () {
        const state = yield* attempt(read);
        const original = state.operations[request.requestId];
        if (original) {
          if (original.fingerprint !== fingerprint) return yield* Effect.fail(new ConfigError("config_idempotency_conflict", "Access request identity was already used for another input."));
          return original.receipt;
        }
        if (revision(state) !== request.expectedRevision) return yield* Effect.fail(new ConfigError("config_conflict", "Access policy changed before publication."));
        if (Object.keys(state.operations).length >= 256) return yield* Effect.fail(new ConfigError("config_invalid", "Access receipt capacity is full; retained identities cannot be evicted automatically."));
        yield* attempt(authorize);
        const installation = yield* attempt(() => readInstallation(root));
        if (installation?.installationId !== installationId || !installation.daemon?.tokenSha256) return yield* Effect.fail(new ConfigError("config_invalid", "Installation authority is unavailable."));
        const grantId = request.action === "grant" ? request.grant.grantId : request.grantId;
        const grants = state.grants.filter(item => item.grantId !== grantId);
        if (request.action === "grant") {
          if (request.grant.tokenSha256 === installation.daemon.tokenSha256 || grants.some(item => item.tokenSha256 === request.grant.tokenSha256)
            || grants.length >= 63) return yield* Effect.fail(new ConfigError("config_invalid", "The verifier is already bound or grant capacity is full."));
          grants.push(request.grant);
        }
        grants.sort((left, right) => left.grantId.localeCompare(right.grantId));
        const next = { ...state, grants };
        const receipt: AccessReceipt = { requestId: request.requestId, revision: revision(next), action: request.action, grantId, committed: true };
        next.operations = { ...state.operations, [request.requestId]: { fingerprint, receipt } };
        // Grants and their exact receipt have one atomic publication. A lost
        // acknowledgement cannot repeat a revoke or resurrect a later grant.
        yield* Effect.uninterruptible(attempt(() => publishConfigFile(path, next, undefined, false, authorize)));
        return receipt;
      }), lease => attempt(lease.release).pipe(Effect.orDie));
    }),
  };
}
