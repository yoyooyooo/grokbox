import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { decideManagedOwnership } from "@grokbox/runtime-kernel/contract";
import { CurrentStateFailure, applicationObservation, continuityObject, continuityStorePolicy, currentStateRpcRequest,
  decodeCurrentStateMaterial, encodeCurrentStateMaterial, initializeCurrentRequest, initializationDigest,
  nativeCurrentHead, sameCurrentHead, isContinuityHash, isContinuityUuid, nativeMaterialParts, readBotSupplement, currentContextSeed, botBirth, botStartup, type BotStartup, type InitializationAttempt, type NativeCurrentHead } from "@grokbox/runtime-kernel/continuity";
import { createNativeCurrentStateOwner } from "./native-current-state-owner.ts";

const fail = (code: ConstructorParameters<typeof CurrentStateFailure>[0]): never => { throw new CurrentStateFailure(code); };
/** Authenticated native Gateway is the transport owner. This finite bridge
 * adds no generic method/path/sender. Only the explicit startup action may
 * enter a model loop; reads and preparation never do. Mutations require confirm
 * and their live scope/Box checks. Configured protection authorization remains
 * owned by the caller's bounded policy controller, not this transport bridge. */
export type NativeLifecycleHost = { create: (args: Record<string, unknown>) => Promise<any>; load: (agentId: string) => Promise<unknown>;
  start: (request: BotStartup, authorize: () => Promise<void>) => Promise<unknown> };
export function createNativeCurrentStateRpc(owner: ReturnType<typeof createNativeCurrentStateOwner>, profileDigest: string) {
  if (!isContinuityHash(profileDigest)) throw Error("invalid_native_profile_identity");
  return async (raw: unknown, readOwnership: () => Promise<unknown>, lifecycle?: NativeLifecycleHost) => {
    try {
      const input = currentStateRpcRequest(raw);
      const read = async (write: boolean, expected?: NativeCurrentHead) => {
        const response = await readOwnership() as any, snapshot = response?.grokboxOwnership;
        if (!snapshot || snapshot.scope?.stable !== true || !isContinuityHash(snapshot.scope.id)) return fail("ownership_unconfirmed");
        const head = owner.readHead(input.agentId, snapshot.scope.id);
        if (expected && !sameCurrentHead(head, expected)) return fail("source_changed");
        const policyRevision = sha256Text(canonicalJson(["manual-current-context-v1", profileDigest, input.agentId, snapshot.scope.id]));
        if (write) {
          if (input.confirm !== true || !decideManagedOwnership({ agentId: input.agentId, snapshot, nowMs: Date.now() }).ok) return fail("ownership_unconfirmed");
        }
        return { head, policyRevision, snapshot };
      };
      if (input.action === "capabilities") {
        if (input.payload !== undefined) return fail("invalid_request");
        const source = (await readOwnership() as any)?.grokboxOwnership;
        const at = Date.parse(source?.serverObservedAt ?? "");
        if (source?.scope?.stable !== true || !isContinuityHash(source.scope.id) || source.state !== "observed"
          || !Number.isFinite(at) || Date.now() < at || Date.now() - at > 5000) return fail("ownership_unconfirmed");
        return { ok: true, data: { qualification: owner.port.qualification, scopeId: source.scope.id, observedAtMs: at,
          policyRevision: sha256Text(canonicalJson(["manual-bot-lifecycle-v1", profileDigest, source.scope.id])),
          supported: ["capture", "compose", "birth", "initialize", "reset", "recover", "startup"], started: false } };
      }
      if (input.action === "head") {
        if (input.payload !== undefined) return fail("invalid_request");
        const { head, policyRevision } = await read(false);
        return { ok: true, data: { head, policyRevision, capability: "single-current-native-state", readyToExecute: false } };
      }
      let payload: any;
      try { payload = JSON.parse(input.payload ?? ""); } catch { return fail("invalid_request"); }
      if (input.action === "birth") {
        if (!lifecycle || input.confirm !== true) return fail("native_unavailable");
        const birth = botBirth(payload);
        if (birth.operationId !== input.agentId) return fail("invalid_request");
        const source = (await readOwnership() as any)?.grokboxOwnership;
        const at = Date.parse(source?.serverObservedAt ?? "");
        if (source?.scope?.id !== birth.scopeId || source.scope.stable !== true || source.state !== "observed"
          || !Number.isFinite(at) || Date.now() < at || Date.now() - at > 5000) return fail("ownership_unconfirmed");
        const result = await owner.withBirth(birth, () => lifecycle.create({ ...birth.profile, harness: "box", clientNonce: birth.operationId,
          isIntroductionSuppressed: true, isKickstartRequested: false }));
        if (!isContinuityUuid(result?.agent?.id)) return fail("commit_unknown");
        return { ok: true, data: { agentId: result.agent.id, operationId: birth.operationId, created: true,
          requestedHarness: "box", ownershipConfirmed: false, started: false } };
      }
      if (input.action === "load") {
        continuityObject(payload, ["scopeId"]);
        if (!lifecycle || input.confirm !== true) return fail("native_unavailable");
        const source = (await readOwnership() as any)?.grokboxOwnership;
        if (source?.scope?.id !== payload.scopeId || !decideManagedOwnership({ agentId: input.agentId, snapshot: source, nowMs: Date.now() }).ok) return fail("ownership_unconfirmed");
        await lifecycle.load(input.agentId);
        const fresh = await read(true);
        return { ok: true, data: { head: fresh.head, policyRevision: fresh.policyRevision, loaded: true, started: false } };
      }
      if (input.action === "startup-status") {
        continuityObject(payload, ["operationId"]);
        if (!isContinuityUuid(payload.operationId)) return fail("invalid_request");
        await read(false);
        return { ok: true, data: owner.startupStatus(input.agentId, payload.operationId) };
      }
      if (input.action === "startup") {
        if (!lifecycle || input.confirm !== true) return fail("native_unavailable");
        const request = botStartup(payload);
        if (request.expected.agentId !== input.agentId) return fail("invalid_request");
        const observed = await read(false);
        if(observed.head.scopeId!==request.expected.scopeId)return fail("source_changed");
        const previous = owner.startupStatus(input.agentId, request.operationId);
        if (previous.state !== "absent") {
          if(previous.inputDigest!==sha256Text(canonicalJson(request)))return fail("operation_conflict");
          return { ok: true, data: previous };
        }
        const authorize = async () => { await read(true, request.expected); };
        await authorize();
        return { ok: true, data: await lifecycle.start(request, authorize) };
      }
      if (input.action === "compose") {
        continuityObject(payload, ["expected", "seed"]);
        const expected = nativeCurrentHead(payload.expected);
        if (expected.agentId !== input.agentId) return fail("invalid_request");
        await read(false, expected);
        const material = await owner.compose(expected, currentContextSeed(payload.seed));
        return { ok: true, data: { material: encodeCurrentStateMaterial(material), nativeStateWritten: false, started: false } };
      }
      if (input.action === "capture") {
        continuityObject(payload, ["expected", "limits"]);
        const expected = nativeCurrentHead(payload.expected);
        if (expected.agentId !== input.agentId) return fail("invalid_request");
        await read(false, expected);
        const lease = await owner.port.capture(expected);
        try {
          const limits = continuityStorePolicy(payload.limits);
          const material = await lease.readMaterial(limits);
          return { ok: true, data: { material: encodeCurrentStateMaterial(material), head: await lease.readHead(), activated: false } };
        } finally { await lease.release(); }
      }
      continuityObject(payload, ["request", "material", "current"]);
      const request = initializeCurrentRequest(payload.request), attempt: InitializationAttempt = { ...request, inputDigest: initializationDigest(request) };
      if (request.expected.agentId !== input.agentId) return fail("invalid_request");
      const initial = await read(["initialize", "activate"].includes(input.action));
      if (initial.head.scopeId !== request.expected.scopeId || initial.policyRevision !== request.policyRevision) return fail("policy_changed");
      if (input.action === "observe") {
        if (payload.material !== undefined || payload.current !== undefined) return fail("invalid_request");
        return { ok: true, data: await owner.port.observeApplication(attempt) };
      }
      if (input.action === "activate") {
        if (payload.material !== undefined) return fail("invalid_request");
        const current = nativeCurrentHead(payload.current);
        // Local persistent frame remains held throughout a new authority check.
        await read(true, current);
        return { ok: true, data: await owner.activate(current, attempt) };
      }
      if (payload.current !== undefined) return fail("invalid_request");
      const material = decodeCurrentStateMaterial(payload.material);
      if (input.action === "preview") {
        // Preview does NOT reserve/hold a target or acquire a write lease.
        if (!sameCurrentHead(initial.head, request.expected)) return fail("source_changed");
        const root = material.manifest.parts.find(part => part.id === material.manifest.root);
        if (!root || root.kind !== "native-root" || material.manifest.gaps.includes("unknown_effects")) return fail("material_invalid");
        readBotSupplement(material);
        return { ok: true, data: { inputDigest: attempt.inputDigest, candidateHash: sha256Text(canonicalJson(nativeMaterialParts(material.manifest.parts))), rootHash: root.hash } };
      }
      // Repeated transport submission checks the original native receipt first;
      // no changed B2 state can be overwritten by replaying an old B0 request.
      const previous = await owner.port.observeApplication(attempt);
      if (previous.state === "applied") return { ok: true, data: { observation: previous, duplicate: true, activated: false } };
      const lease = await owner.port.initialize(attempt);
      let disposition: "prepared" | "blocked" = "blocked", result: unknown, dispatched = false;
      try {
        const candidate = await lease.prepare(material, attempt);
        await read(true, request.expected);
        dispatched = true;
        await lease.commit(attempt, candidate);
        const current = await lease.reopen();
        const observation = applicationObservation(await lease.application(attempt), attempt);
        if (observation.state !== "applied" || !sameCurrentHead(observation.current, current)
          || current.rootHash !== candidate.rootHash || observation.marker.candidateHash !== candidate.candidateHash) return fail("commit_unknown");
        disposition = "prepared";
        result = { observation, duplicate: false, activated: false };
      } catch (cause) {
        if (dispatched) return fail("commit_unknown");
        throw cause;
      } finally {
        try { await lease.release(disposition); } catch { fail("cleanup_unknown"); }
      }
      return { ok: true, data: result };
    } catch (cause) {
      const code = cause instanceof CurrentStateFailure ? cause.code : "native_unavailable";
      return { ok: false, error: { code } };
    }
  };
}
