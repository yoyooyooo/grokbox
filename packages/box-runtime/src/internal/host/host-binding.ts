import { sha256Text } from "@grokbox/runtime-kernel/hash";
import type { CompileReceipt } from "./compile-receipt.ts";
import type { StableProcessIdentity } from "../process/process-port.ts";
import { boundedText, count, isRecord } from "../io/observation.node.ts";

/** Correlation/fencing facts, not a bearer capability or peer authentication. No argv on the wire. */
export type HostBinding = {
  generationId: string;
  activationId: string;
  pid: number;
  start: number;
  sourceSha: string;
  identitySha: string;
};
export function stableIdentitySha(identity: StableProcessIdentity): string {
  return sha256Text(JSON.stringify([identity.pid, identity.uid, identity.start, identity.exe, identity.cmdline]));
}
export function bindCompiledHost(identity: StableProcessIdentity, operationId: string, compile: CompileReceipt): HostBinding {
  return parseHostBinding({
    generationId: sha256Text(JSON.stringify([identity.pid, identity.start, operationId,
      compile.profileId, compile.profileSha256, compile.sourceSha256, compile.transformedSha256])),
    activationId: operationId, pid: identity.pid, start: identity.start,
    sourceSha: compile.sourceSha256, identitySha: stableIdentitySha(identity),
  });
}
export function parseHostBinding(value: unknown): HostBinding {
  if (!isRecord(value) || Object.keys(value).length !== 6 ||
    !boundedText(value.activationId, 128) || !count(value.pid) || value.pid === 0 || !count(value.start) ||
    ![value.generationId, value.sourceSha, value.identitySha].every((v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v))) {
    throw new Error("invalid Host binding");
  }
  return Object.freeze({ generationId: value.generationId as string, activationId: value.activationId,
    pid: value.pid, start: value.start, sourceSha: value.sourceSha as string, identitySha: value.identitySha as string });
}
export function bindingMismatch(expected: HostBinding, actual: HostBinding) {
  if (expected.generationId !== actual.generationId) return "wrong-generation" as const;
  if (expected.activationId !== actual.activationId) return "wrong-activation" as const;
  if (expected.sourceSha !== actual.sourceSha) return "wrong-source" as const;
  if (expected.pid !== actual.pid || expected.start !== actual.start || expected.identitySha !== actual.identitySha) return "wrong-identity" as const;
  return null;
}
