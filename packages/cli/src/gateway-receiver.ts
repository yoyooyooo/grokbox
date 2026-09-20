import { NATIVE_ROUTINE_MAX_BYTES } from "@grokbox/runtime-kernel/routines";
import { createNotificationReceiver, reviewedProfilePath, type ReceiverNativeReader, type ExplicitReceiverReader } from "@grokbox/box-runtime/runtime";
import { GatewayClient } from "./gateway.ts";
import type { CliDeps } from "./deps.ts";

/** Remaining local CLI consumers borrow the same narrow receiver projection as
 * the management Server. This adapter only supplies native reads, never model
 * calls, key acquisition or an alternative notification writer. */
function receiver(deps: CliDeps, timeoutMs: number) {
  const local = () => {
    if (deps.daemonServerUrl || deps.gatewayServerUrl || deps.sshHost) throw Error("receiver_requires_local_source");
  };
  return createNotificationReceiver({
    readProfile: async () => {
      local();
      const bytes = await deps.readFile(reviewedProfilePath(deps.boxRuntimeRoot));
      if (Buffer.byteLength(bytes) > 1024 * 1024) throw Error("receiver_profile_unavailable");
      return JSON.parse(bytes) as unknown;
    },
    call: async (method, input, signal, timeoutMs) => {
      local();
      const reply = await new GatewayClient({ ...deps, transport: "local", signal }).rpc(method, input, { timeoutMs, maxResponseBytes: NATIVE_ROUTINE_MAX_BYTES });
      return { result: reply.result, source: { baseUrl: reply.discovery.baseUrl, pid: reply.discovery.pid, startedAt: reply.discovery.startedAt } };
    },
  }, Math.min(timeoutMs, 15_000));
}
export function nativeReceiverReader(deps: CliDeps, timeoutMs: number): ReceiverNativeReader {
  return receiver(deps, timeoutMs).read;
}
export function nativeExplicitReceiverReader(deps: CliDeps, timeoutMs: number): ExplicitReceiverReader {
  return receiver(deps, timeoutMs).readExplicit;
}
