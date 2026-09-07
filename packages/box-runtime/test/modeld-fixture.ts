import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindCompiledHost } from "../src/modeld-binding.ts";
import { writeAttestation, type RouteAttestation } from "../src/attestation.ts";
import { writeAdoptOpState } from "../src/transient-adopt.ts";
import { openRuntimeStore, type ModelsFile } from "../src/models.ts";
import { buildModelEnvelope } from "../src/envelope.ts";
import { sha256Text } from "../src/hash.ts";
import type { AdmitRequest } from "../src/modeld.ts";
import type { StubModeldServer } from "../src/modeld-ipc.ts";

export const FAKE_HOST = { pid: 4242, start: 123, uid: 1000, exe: "/fixture/node", cmdline: ["node", "/fixture/host.cjs"], ppid: 1, ancestry: [] };
export const FAKE_COMPILE = { profileId: "fixture-reviewed", profileSha256: sha256Text("fixture-profile"),
  sourceSha256: sha256Text("fixture-source"), transformedSha256: sha256Text("fixture-transformed") };
export const FAKE_BINDING = bindCompiledHost(FAKE_HOST, "fixture-operation", FAKE_COMPILE);
export const STUB_MODELS: ModelsFile = { version: 1, models: {}, assignments: { main: "stub/echo", agents: {} } };
export function fakeModels(): ModelsFile {
  const record = (model: string) => ({ id: `fake/${model}`, provider: "fake", model, endpoint: `fake:${model}`, apiKeyRef: `env:FAKE_${model.toUpperCase()}`,
    capabilities: { vision: false, tools: true, images: false }, dataTypes: ["text", "tools"] });
  return { version: 1, models: { "fake/fast": record("fast"), "fake/smart": record("smart") }, assignments: { main: "fake/fast", agents: { "agent-tom": "fake/smart" } } };
}
export const FAKE_ATTESTATION: RouteAttestation = { coverage: "attested", mode: "route", modeld: true,
  diskSha: FAKE_COMPILE.sourceSha256, pid: FAKE_HOST.pid, start: FAKE_HOST.start, identity: FAKE_HOST,
  operationId: FAKE_BINDING.activationId, compile: FAKE_COMPILE, profileId: FAKE_COMPILE.profileId,
  transformedSha: FAKE_COMPILE.transformedSha256, at: "2026-01-01T00:00:00.000Z", launchMode: "transient-adopt" };
export async function writeModeldAuthority(runRoot: string, att = FAKE_ATTESTATION) {
  await writeAttestation(runRoot, att);
  await writeAdoptOpState(runRoot, { launchMode: "transient-adopt", phase: "attested", operationId: att.operationId,
    compile: att.compile, host: att.identity, tempSupervisor: null, adoptingSupervisor: { ...FAKE_HOST, pid: 4343 } });
}
export async function modeldFixture() {
  const root = await mkdtemp(join(tmpdir(), "grokbox-modeld-admit-"));
  const durable = join(root, "durable"); const runRoot = join(root, "run");
  const store = openRuntimeStore(durable);
  await store.saveDesired({ version: 1, mode: "route" }); await store.saveModels(STUB_MODELS);
  await writeModeldAuthority(runRoot);
  return { root, durable, runRoot, store, binding: FAKE_BINDING };
}
export function submitRequest(server: Pick<StubModeldServer, "serverGeneration">, invocationId: string, changes: Partial<AdmitRequest> = {}) {
  return { method: "submit", serverGeneration: server.serverGeneration, host: FAKE_BINDING, invocationId,
    turnId: invocationId, agentId: "agent-tom", envelope: buildModelEnvelope([{ role: "user", content: "fixture prompt" }]), ...changes };
}
