import { createCurrentStateClient, openContinuityCurrentState, openContinuityRecoveryStore } from "@grokbox/box-runtime/runtime";
import { ContinuityFailure, CurrentStateFailure, initializationDigest, isContinuityHash, isContinuityUuid,
  nativeCurrentHead, continuityId, readBotSupplement, summaryFromSupplement, type InitializeCurrentRequest, type CurrentStateRpcRequest } from "@grokbox/runtime-kernel/continuity";
import { decideManagedOwnership } from "@grokbox/runtime-kernel/contract";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import type { CliDeps } from "../deps.ts";
import { GatewayClient, gatewayMeta, type Discovery } from "../gateway.ts";
import { CliError, usage } from "../errors.ts";
import { writeSuccess } from "../output.ts";
import { ioFromOpts } from "../opts.ts";
import { isRecord } from "../util.ts";

type Action = "show" | "capture" | "initialize" | "reset" | "recover" | "operation" | "reconcile" | "activate";
type Options = { timeoutMs?: string; json?: boolean; operationId?: string; snapshotId?: string; expectRevision?: string; scopeId?: string; confirm?: boolean };
const stableUuid = (text: string) => { const hash = sha256Text(text); return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`; };

/** Local Box control only. Protected contents are kept in CONT; CLI output is
 * metadata/receipts, never raw prompt, Memory or base64 payload. No implicit
 * create/clone/start/model selection/repair is hidden behind these primitives. */
export async function runAgentState(deps: CliDeps, action: Action, agentId: string, raw: Options): Promise<void> {
  if (!isContinuityUuid(agentId) || action !== "show" && !isContinuityUuid(raw.operationId)) throw usage("An exact Bot UUID and stable operation UUID are required.");
  if (!["show", "operation"].includes(action) && raw.confirm !== true) throw usage("This state operation requires --confirm.");
  if (action === "initialize" && (!isContinuityUuid(raw.snapshotId) || !isContinuityHash(raw.expectRevision))) throw usage("Initialization requires --snapshot-id and --expect-revision from state show.");
  if ((action === "reset" || action === "recover") && (!isContinuityHash(raw.expectRevision) || action === "recover" && !isContinuityUuid(raw.snapshotId))) throw usage("Reset/recover requires --expect-revision; recover also requires --snapshot-id.");
  if (action === "operation" && !isContinuityHash(raw.scopeId)) throw usage("Offline operation inspection requires the original --scope-id.");
  if (!["auto", "local"].includes(deps.transport) || deps.sshHost || deps.daemonServerUrl || deps.gatewayServerUrl) {
    throw new CliError("capability_unavailable", "Current-state management is Box-local; remote transport and cross-machine restoration are not supported.");
  }
  const io = ioFromOpts({ ...raw, timeoutMs: raw.timeoutMs ?? "60000" });
  try {
    if (action === "operation") {
      const store = openContinuityRecoveryStore({ durableRoot: deps.boxRuntimeRoot, scopeId: raw.scopeId! });
      const operation = await store.operation(raw.operationId!);
      if (operation.agentId !== agentId) throw usage("Operation belongs to a different Bot.");
      writeSuccess(deps.stdout, { operation, nativeCurrentChecked: false }); return;
    }
    const gateway = new GatewayClient(deps); let generation: Discovery | undefined;
    const call = async (request: CurrentStateRpcRequest): Promise<unknown> => {
      const response = await gateway.currentStateControl(request, io.timeoutMs);
      if (generation && (generation.pid !== response.discovery.pid || generation.startedAt !== response.discovery.startedAt)) {
        throw new CurrentStateFailure("source_changed");
      }
      generation = response.discovery; return response.result;
    };
    const initial = await call({ version: 1, action: "head", agentId });
    if (!isRecord(initial) || initial.ok !== true || !isRecord(initial.data)) throw new CliError("capability_unavailable", "The loaded Host has no qualified current-state capability.");
    const head = nativeCurrentHead(initial.data.head);
    if (head.agentId !== agentId || !isContinuityHash(initial.data.policyRevision)) throw new CurrentStateFailure("source_changed");
    const client = createCurrentStateClient({ call, qualification: { hostSourceSha: head.hostSourceSha, nativeSchema: head.nativeSchema } });
    if (action === "show") { writeSuccess(deps.stdout, initial.data, gatewayMeta(generation!)); return; }
    const store = openContinuityRecoveryStore({ durableRoot: deps.boxRuntimeRoot, scopeId: head.scopeId });
    // Explicitly confirmed writes may initialize/migrate this private CONT store;
    // they do not migrate canonical config or change any Host profile/service.
    await store.initialize(deps.signal);
    if (action === "capture") {
      const old = await store.publication(raw.operationId!).catch(error => {
        if (error instanceof ContinuityFailure && error.code === "not_found") return null; throw error;
      });
      if (old) {
        const checked = await store.reconcilePublication(raw.operationId!, "verify", deps.signal);
        if (checked.state === "published") {
          const saved = await store.readSnapshot(raw.operationId!);
          if (saved.manifest.source.agentId !== agentId) throw usage("Capture operation belongs to a different Bot.");
        }
        writeSuccess(deps.stdout, { publication: checked, scopeId: head.scopeId, sourceRead: false, activated: false }, gatewayMeta(generation!)); return;
      }
      const program = openContinuityCurrentState({ durableRoot: deps.boxRuntimeRoot, scopeId: head.scopeId, native: client.port });
      const result = await program.capture({ requestId: raw.operationId!, expected: head }, deps.signal);
      writeSuccess(deps.stdout, { ...result, scopeId: head.scopeId }, gatewayMeta(generation!)); return;
    }
    let request = await store.initializationRequest(raw.operationId!).catch(error => {
      if (error instanceof ContinuityFailure && error.code === "not_found") return null; throw error;
    });
    if (request && request.expected.agentId !== agentId) throw usage("Initialization belongs to a different Bot.");
    if (action === "reset" || action === "recover") {
      if (request && (request.mode !== action || request.expected.contextRevision !== raw.expectRevision)) throw usage("This operation has a different saved reset/recovery request.");
      if (!request) {
        if (head.contextRevision !== raw.expectRevision || head.rootHash === null) throw new CurrentStateFailure("source_changed");
        const backupId = continuityId(raw.operationId, "before-current-replacement"), candidateId = continuityId(raw.operationId, "current-replacement");
        const capture = openContinuityCurrentState({ durableRoot: deps.boxRuntimeRoot, scopeId: head.scopeId, native: client.port });
        await capture.capture({ requestId: backupId, expected: head }, deps.signal);
        const backup = await store.readSnapshot(backupId);
        let candidate = action === "recover" ? await store.readSnapshot(raw.snapshotId!) : null;
        if (action === "reset" || candidate?.manifest.gaps.includes("unknown_effects")) {
          const supplement = candidate ? readBotSupplement(candidate) : null;
          candidate = { ...(await client.compose(head, { version: 1, purpose: action, sourceId: agentId, sourceRevision: head.contextRevision,
            instructions: "", summary: supplement ? summaryFromSupplement({ ...supplement, sourceId: agentId }) : "" })), reference: backup.reference } as typeof candidate;
        }
        if (!candidate) throw new CurrentStateFailure("material_invalid");
        await store.publish({ requestId: candidateId, manifest: candidate.manifest, content: candidate.content }, deps.signal);
        request = { operationId: raw.operationId!, effectId: continuityId(raw.operationId, "current-replacement-effect"), expected: head,
          snapshot: (await store.readSnapshot(candidateId)).reference, policyRevision: initial.data.policyRevision,
          mode: action, backupSnapshot: backup.reference };
      }
    }
    if (action === "initialize") {
      if (request && (request.snapshot.ref !== raw.snapshotId || request.expected.contextRevision !== raw.expectRevision)) throw usage("This operation already has different input; do not reuse its UUID.");
      if (!request) {
        if (head.contextRevision !== raw.expectRevision) throw new CurrentStateFailure("source_changed");
        const publication = await store.publication(raw.snapshotId!);
        if (publication.state !== "published") throw new CurrentStateFailure("material_invalid");
        request = { operationId: raw.operationId!, effectId: stableUuid(canonicalJson([agentId, head.scopeId, raw.operationId, "initialize"])),
          snapshot: publication.reference, expected: head, policyRevision: initial.data.policyRevision };
      }
    }
    if (!request) throw usage("No saved initialization request exists for this operation.");
    const exact = request as InitializeCurrentRequest;
    const program = openContinuityCurrentState({ durableRoot: deps.boxRuntimeRoot, scopeId: head.scopeId, native: client.port,
      authorizeInitialization: async asked => {
        const now = await client.head(agentId), proof = await gateway.getAgentOwnership([agentId], io.timeoutMs);
        const snapshot = proof.result as any;
        const stable = generation?.pid === proof.discovery.pid && generation?.startedAt === proof.discovery.startedAt;
        return { allowed: stable && now.policyRevision === asked.policyRevision, operationId: asked.operationId, agentId, scopeId: now.head.scopeId,
          policyRevision: now.policyRevision, hostGeneration: now.head.hostGeneration,
          ownership: stable && decideManagedOwnership({ agentId, snapshot, nowMs: Date.now() }).ok ? "confirmed_box" : "unconfirmed",
          observedAtMs: Date.parse(snapshot?.serverObservedAt ?? snapshot?.observedAt ?? "") };
      } });
    const result = ["initialize", "reset", "recover"].includes(action) ? await program.initialize(exact, deps.signal)
      : action === "reconcile" ? await program.reconcile(exact, deps.signal)
      : await client.activate({ ...exact, inputDigest: initializationDigest(exact) }, (await client.head(agentId)).head);
    writeSuccess(deps.stdout, { result, operationId: exact.operationId, scopeId: head.scopeId, startedTask: false }, gatewayMeta(generation!));
  } catch (error) {
    if (error instanceof CliError) throw error;
    const code = error instanceof CurrentStateFailure || error instanceof ContinuityFailure ? error.code : "unavailable";
    throw new CliError(["commit_unknown", "cleanup_unknown"].includes(code) ? "operation_outcome_unknown" : "capability_unavailable",
      "Current-state operation did not complete.", { hostReason: code,
        next: "Inspect the same operation and reconcile its saved request; do not create another operation to replay an unknown native write." });
  }
}
