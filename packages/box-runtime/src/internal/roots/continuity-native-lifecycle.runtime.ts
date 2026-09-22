import { createCurrentStateClient } from "../io/current-state-client.node.ts";
import { openRuntimeStore } from "../io/configuration.node.ts";
import { selectLifecycleModel } from "./continuity-model.runtime.ts";
import { openContinuityCurrentState } from "./continuity-state.runtime.ts";
import { openContinuityRecoveryStore } from "./continuity.runtime.ts";
import type { BotLifecyclePort } from "./bot-lifecycle.runtime.ts";
import { replaceSupplementInstructions, summaryFromSupplement, readBotSupplement, continuityId, initializationDigest,
  nativeQualification, isContinuityHash, isContinuityUuid, CurrentStateFailure, ContinuityFailure,
  type BotWorkflowRequest, type CurrentStateRpcRequest, type NativeMaterial, type NativeQualification } from "@grokbox/runtime-kernel/continuity";
import { captureManagedSelection, modelForAgent, requireModel, applyUse, applyReset, parseRequestedEffort } from "@grokbox/runtime-kernel/selection";
import { decideManagedOwnership } from "@grokbox/runtime-kernel/contract";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import type { NativeContinuityContext, ContinuityDiscovery } from "../io/continuity-gateway.node.ts";
import { nativeMaterialReader, botProfileRevision } from "../io/continuity-material.node.ts";

const fail = (code: ConstructorParameters<typeof CurrentStateFailure>[0]): never => { throw new CurrentStateFailure(code); };
const generation = (d: ContinuityDiscovery) => canonicalJson([d.baseUrl, d.pid, d.startedAt]);
/** Shared native composition for manual lifecycle and background protection.
 * The CONT program owns dispatch and recovery; this adapter never patches the
 * native database, changes a harness, or substitutes a hidden user task. */
export function createNativeBotLifecycle(deps: NativeContinuityContext, input: { timeoutMs: number;
  handover?: BotLifecyclePort["handover"]; authorizePolicy?: (request: BotWorkflowRequest) => Promise<boolean>;
  authorizeManagement?: (request: BotWorkflowRequest) => Promise<boolean> }) {
  const gateway = deps.gateway(), runtime = openRuntimeStore(deps.boxRuntimeRoot, deps.env);
  let identity: string | undefined, qualification: NativeQualification | undefined;
  const check = <A>(response: { result: A; discovery: ContinuityDiscovery }): A => {
    const seen = generation(response.discovery);
    if (identity !== undefined && identity !== seen) return fail("source_changed");
    identity = seen; return response.result;
  };
  const call = async (request: CurrentStateRpcRequest) => check(await gateway.currentStateControl(request, input.timeoutMs));
  const capabilities = async (referenceId: string) => {
    const response = await call({ version: 1, action: "capabilities", agentId: referenceId }) as any;
    if (response?.ok !== true || !isContinuityHash(response.data?.scopeId) || !isContinuityHash(response.data?.policyRevision)) return fail("native_unavailable");
    const found = nativeQualification(response.data.qualification);
    if (qualification && canonicalJson(qualification) !== canonicalJson(found)) return fail("qualification_mismatch");
    qualification = found;
    const observedAtMs = response.data.observedAtMs;
    if (!Number.isSafeInteger(observedAtMs) || Date.now() < observedAtMs || Date.now() - observedAtMs > 5000) return fail("ownership_unconfirmed");
    return { scopeId: response.data.scopeId as string, policyRevision: response.data.policyRevision as string, qualification: found, observedAtMs };
  };
  const client = () => {
    if (!qualification) return fail("native_unavailable");
    return createCurrentStateClient({ call, qualification });
  };
  const ownerProof = async (agentId: string, expectedScope?: string) => {
    const snapshot = check(await gateway.getAgentOwnership([agentId], Math.min(input.timeoutMs, 15000))) as any;
    const at = Date.parse(snapshot?.serverObservedAt ?? "");
    if (snapshot?.scope?.stable !== true || !isContinuityHash(snapshot.scope.id) || expectedScope && snapshot.scope.id !== expectedScope
      || !Number.isFinite(at) || Date.now() < at || Date.now() - at > 5000) return fail("ownership_unconfirmed");
    return { snapshot, scopeId: snapshot.scope.id as string, observedAtMs: at };
  };
  const reader = nativeMaterialReader(gateway, check, input.timeoutMs);
  const selected = async (sourceId: string | null, requested?: string | null, effort?: string) => {
    const file = await runtime.loadModels(), resolved = sourceId ? modelForAgent(file, sourceId) : null;
    const captured = sourceId ? captureManagedSelection(file, sourceId) : { kind: "official" as const };
    const modelRef = requested === undefined ? captured.kind === "managed" ? captured.modelId : null : requested;
    const reasoning = resolved?.reasoning as any;
    const selectedEffort = effort ?? (requested === undefined ? reasoning?.effort : undefined);
    const record = modelRef === null ? null : requireModel(file, modelRef);
    return { modelRef, ...(selectedEffort ? { effort: selectedEffort as string } : {}),
      modelRevision: sha256Text(canonicalJson({ modelRef, record, effort: selectedEffort ?? null })) };
  };
  const storeFor = (request: BotWorkflowRequest) => openContinuityRecoveryStore({ durableRoot: deps.boxRuntimeRoot, scopeId: request.scopeId });
  const published = async (request: BotWorkflowRequest, snapshotId: string) => {
    try { return await storeFor(request).readSnapshot(snapshotId); }
    catch (error) { if (error instanceof ContinuityFailure && error.code === "not_found") return null; throw error; }
  };
  const describe = (snapshotId: string, material: NativeMaterial, revision: string) => ({ snapshotId, revision, quality: material.manifest.quality, gaps: material.manifest.gaps });
  const verifySelection = async (request: BotWorkflowRequest, targetId: string) => {
    const chosen = await selected(null, request.modelRef, request.effort);
    if (chosen.modelRevision !== request.modelRevision) return fail("policy_changed");
    const models = await runtime.loadModels(), current = captureManagedSelection(models, targetId);
    const expected = request.modelRef === null ? applyReset(models, targetId) : applyUse(models, request.modelRef, targetId, parseRequestedEffort(request.effort));
    if (canonicalJson(current) !== canonicalJson(captureManagedSelection(expected, targetId))) return fail("policy_changed");
  };
  const native: BotLifecyclePort = {
    authorize: async request => {
      deps.signal?.throwIfAborted();
      if (request.management && !input.authorizeManagement) return fail("policy_changed");
      const caps = await capabilities(request.sourceId ?? request.operationId);
      if (request.management && !await input.authorizeManagement!(request)) return fail("policy_changed");
      const allowed = caps.scopeId === request.scopeId && (input.authorizePolicy ? await input.authorizePolicy(request) : caps.policyRevision === request.policyRevision);
      return { allowed, scopeId: caps.scopeId, policyRevision: request.policyRevision, observedAtMs: caps.observedAtMs };
    },
    capture: async (request, snapshotId) => {
      const store = storeFor(request), prior = await published(request, snapshotId);
      if (prior) return describe(snapshotId, prior, prior.reference.revision);
      if (!request.sourceId || !qualification) return fail("invalid_request");
      if (request.sourceRevision && botProfileRevision(await reader.profile(request.sourceId)) !== request.sourceRevision) return fail("source_changed");
      if (request.snapshotId) {
        const source = await store.readSnapshot(request.snapshotId);
        if (source.manifest.source.agentId !== request.sourceId) return fail("source_changed");
        const saved = await store.publish({ requestId: snapshotId, manifest: source.manifest, content: source.content }, deps.signal);
        return describe(snapshotId, source, saved.reference.revision);
      }
      try {
        const state = await client().head(request.sourceId);
        const program = openContinuityCurrentState({ durableRoot: deps.boxRuntimeRoot, scopeId: request.scopeId, native: client().port });
        await program.capture({ requestId: snapshotId, expected: state.head }, deps.signal);
      } catch (error) {
        deps.signal?.throwIfAborted();
        const saved = await published(request, snapshotId); if (saved) return describe(snapshotId, saved, saved.reference.revision);
        if (error instanceof CurrentStateFailure && ["source_changed", "cleanup_unknown", "commit_unknown"].includes(error.code)) throw error;
        return fail("native_unavailable");
      }
      const result = await store.readSnapshot(snapshotId); return describe(snapshotId, result, result.reference.revision);
    },
    create: async (request, operationId) => {
      const created = await client().birth({ operationId, scopeId: request.scopeId, profile: request.profile, instructions: request.instructions });
      if (!isContinuityUuid(created?.agentId) || created.agentId === request.sourceId || created.created !== true || created.started !== false) return fail("commit_unknown");
      return { agentId: created.agentId, created: true, started: false };
    },
    load: async (request, targetId) => {
      const loaded = await client().load(targetId, request.scopeId);
      if (loaded?.head?.agentId !== targetId || loaded.loaded !== true) return fail("native_unavailable");
      return { agentId: targetId, loaded: true };
    },
    model: (request, targetId, operationId) => selectLifecycleModel({ store: runtime, workflow: request, targetId, operationId,
      ownershipRead: deps.ownershipRead, signal: deps.signal, env: deps.env, fetch: deps.fetch,
      verifyModel: async () => { if ((await selected(null, request.modelRef, request.effort)).modelRevision !== request.modelRevision) fail("policy_changed"); },
      authorize: async () => { const permission = await native.authorize(request, "model");
        if (!permission.allowed || permission.scopeId !== request.scopeId || permission.policyRevision !== request.policyRevision
          || Date.now() < permission.observedAtMs || Date.now() - permission.observedAtMs > 5000) fail("policy_changed"); },
    }),
    compose: async (request, targetId, sourceSnapshotId, snapshotId) => {
      const store = storeFor(request), prior = await published(request, snapshotId);
      if (prior) return describe(snapshotId, prior, prior.reference.revision);
      const target = await client().head(targetId), source = sourceSnapshotId ? await store.readSnapshot(sourceSnapshotId) : null;
      let material: NativeMaterial;
      if (source?.manifest.quality === "native_checkpoint" && !source.manifest.gaps.includes("unknown_effects") && source.manifest.source.nativeSchema === target.head.nativeSchema) {
        material = request.instructions && readBotSupplement(source) ? replaceSupplementInstructions(source, request.instructions) : source;
      } else {
        const supplement = source ? readBotSupplement(source) : null;
        material = await client().compose(target.head, { version: 1, purpose: request.kind === "spawn" ? "spawn" : "clone",
          sourceId: source?.manifest.source.agentId ?? targetId, sourceRevision: sha256Text(canonicalJson(source?.manifest ?? [request.operationId, "empty-seed"])),
          instructions: request.instructions || supplement?.instructions || "", summary: supplement ? summaryFromSupplement(supplement) : "", ...(supplement ? { supplement } : {}) });
      }
      const saved = await store.publish({ requestId: snapshotId, ...material }, deps.signal);
      return describe(snapshotId, material, saved.reference.revision);
    },
    initialize: async (request, targetId, snapshotId, operationId) => {
      const store = storeFor(request);
      let saved = await store.initializationRequest(operationId).catch(error => { if (error instanceof ContinuityFailure && error.code === "not_found") return null; throw error; });
      if (!saved) {
        const now = await client().head(targetId), material = await store.readSnapshot(snapshotId);
        saved = { operationId, effectId: continuityId(operationId, "apply"), expected: now.head, snapshot: material.reference, policyRevision: now.policyRevision };
      }
      const program = openContinuityCurrentState({ durableRoot: deps.boxRuntimeRoot, scopeId: request.scopeId, native: client().port,
        authorizeInitialization: async asked => {
          const now = await client().head(targetId), proof = await ownerProof(targetId, request.scopeId);
          return { allowed: now.policyRevision === asked.policyRevision, operationId: asked.operationId, agentId: targetId,
            scopeId: request.scopeId, policyRevision: now.policyRevision, hostGeneration: now.head.hostGeneration,
            ownership: decideManagedOwnership({ agentId: targetId, snapshot: proof.snapshot, nowMs: Date.now() }).ok ? "confirmed_box" : "unconfirmed", observedAtMs: proof.observedAtMs };
        } });
      const result = await program.initialize(saved, deps.signal);
      return { operationId, state: result.state };
    },
    activate: async (request, targetId, initializationId) => {
      await verifySelection(request, targetId);
      const saved = await storeFor(request).initializationRequest(initializationId), current = await client().head(targetId);
      if (saved.expected.agentId !== targetId) return fail("source_changed");
      const result = await client().activate({ ...saved, inputDigest: initializationDigest(saved) }, current.head);
      if (result?.state !== "released" || result.started !== false) return fail("commit_unknown");
      return { state: "released", activated: true, started: false };
    },
    startup: async (request, targetId, operationId) => {
      const prior = await client().startupStatus(targetId, operationId);
      if (prior.state !== "absent") return prior;
      await verifySelection(request, targetId);
      return client().startup({ operationId, expected: (await client().head(targetId)).head, maxRunMs: request.maxRunMs });
    },
    handover: async (request, targetId) => { if (!input.handover) return fail("native_unavailable"); return input.handover(request, targetId); },
  };
  const captureMemory = async (request: BotWorkflowRequest, snapshotId: string) => {
    if (!request.sourceId || !qualification) return fail("invalid_request");
    const prior = await published(request, snapshotId); if (prior) return describe(snapshotId, prior, prior.reference.revision);
    return fail("native_unavailable");
  };
  return { native, capabilities, captureMemory, profile: reader.profile, selected, client, gateway };
}
