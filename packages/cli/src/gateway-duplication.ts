import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { inspectOwnership, OWNERSHIP_EVIDENCE_MAX_AGE_MS } from "@grokbox/runtime-kernel/contract";
import { duplicateCreated, duplicateSource, type DuplicateCreated, type NativeDuplicatePort } from "@grokbox/runtime-kernel/continuity";
import { projectNativeRoutines, NATIVE_ROUTINE_MAX_BYTES } from "@grokbox/runtime-kernel/routines";
import { GatewayClient, type Discovery } from "./gateway.ts";
import { CliError } from "./errors.ts";
import { findRosterRow } from "./commands/roster.ts";
import { isRecord } from "./util.ts";

// Bind authentication generation without persisting or printing credential bytes.
const generation = (d: Discovery) => sha256Text(canonicalJson([d.baseUrl, d.pid, d.startedAt, sha256Text(d.token)]));
const refuse = (): never => { throw new CliError("capability_unavailable", "The native duplication preflight is incomplete or changed."); };
function profileRevision(row: Record<string, unknown>) {
  const profile: Record<string, string> = {};
  for (const key of ["name", "description", "title", "avatarShape", "avatarColor"]) {
    const value = row[key] ?? "";
    if (typeof value !== "string" || new TextEncoder().encode(value).length > 128 * 1024) return refuse();
    profile[key] = value;
  }
  return sha256Text(canonicalJson(profile));
}
/** Original Gateway operations only. Routine projection is an observed window,
 * NOT a claim that Temporal-side schedules or every local file were enumerated.
 * No credential getter, source mutation, wake, rename or managed route change. */
export function nativeDuplicationGateway(client: GatewayClient, timeoutMs: number): NativeDuplicatePort {
  const deadline = performance.now() + timeoutMs;
  const remaining = () => {
    const left = Math.floor(deadline - performance.now());
    if (left < 1) return refuse();
    return left;
  };
  return {
    inspectSource: async agentId => {
      const listed = await client.listAgents(remaining()), row = findRosterRow(listed.agents, agentId, ["agent"]);
      if (row.id !== agentId) return refuse();
      const routines = await client.rpc("getAgentAutomations", { id: agentId }, { timeoutMs: remaining(), maxResponseBytes: NATIVE_ROUTINE_MAX_BYTES });
      const catalog = projectNativeRoutines(agentId, routines.result);
      const ownership = await client.getAgentOwnership([agentId], remaining());
      const gen = generation(listed.discovery);
      if (gen !== generation(routines.discovery) || gen !== generation(ownership.discovery)) return refuse();
      const proof = inspectOwnership({ agentIds: [agentId], snapshot: ownership.result });
      const source = proof.agents[0], observedAtMs = Date.parse(proof.serverObservedAt ?? "");
      if (!proof.scope?.stable || !proof.scope.id || !source || source.server?.viewerIsOwner !== true
        || !["confirmed_box", "confirmed_temporal"].includes(source.state) || proof.localMigrationWindow === "active"
        || !Number.isSafeInteger(observedAtMs) || Date.now() < observedAtMs || Date.now() - observedAtMs > OWNERSHIP_EVIDENCE_MAX_AGE_MS) return refuse();
      return duplicateSource({ agentId, scopeId: proof.scope.id, generation: gen,
        profileRevision: profileRevision(row), routineRevision: sha256Text(canonicalJson(catalog.routines.map(r => [r.id, r.revision]).sort((a,b) => a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0))),
        harness: source.state === "confirmed_box" ? "box" : "temporal", observedAtMs,
        returnedRoutines: catalog.routines.length, enabledRoutines: catalog.routines.filter(r => r.enabled).length, routineCoverage: "native_returned_window" });
    },
    duplicate: async (request, current) => {
      const reply = await client.duplicateAgent(request.source.agentId, request.source.generation, current.observedAtMs, remaining());
      if (generation(reply.discovery) !== request.source.generation || !isRecord(reply.result) || !isRecord(reply.result.agent)
        || reply.result.agent.isGroup === true) throw new CliError("operation_outcome_unknown", "Native duplication returned no qualified identity receipt; do not repeat creation.");
      return duplicateCreated({ version: 1, operationId: request.operationId, sourceAgentId: request.source.agentId,
        targetAgentId: reply.result.agent.id, scopeId: request.source.scopeId, generation: request.source.generation,
        receivedAtMs: Date.now(), evidence: "native_response" }, request);
    },
    inspectTarget: async (created: DuplicateCreated) => {
      const reply = await client.getAgentOwnership([created.targetAgentId], remaining());
      const proof = inspectOwnership({ agentIds: [created.targetAgentId], snapshot: reply.result,
        gatewayChanged: generation(reply.discovery) !== created.generation });
      const row = proof.agents[0], observedAt = Date.parse(proof.serverObservedAt ?? "");
      if (!row || proof.scope?.stable !== true || proof.scope.id !== created.scopeId
        || !Number.isFinite(observedAt) || Date.now() < observedAt || Date.now() - observedAt > OWNERSHIP_EVIDENCE_MAX_AGE_MS) return { agentId: created.targetAgentId, state: "unconfirmed", readBack: false };
      return { agentId: created.targetAgentId, state: row.state, readBack: true };
    },
  };
}
