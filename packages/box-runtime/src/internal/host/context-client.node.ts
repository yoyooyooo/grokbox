import { createConnection, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ContextFailure, contextFailure, parseContextReceipt, CONTEXT_MATERIAL_MAX_BYTES, WIRE_VERSION,
  type ContextMaintenanceRequest, type ContextMaintenanceReceipt, type SelectionIdentity, type CapturedContextPolicy } from "@grokbox/runtime-kernel/contract";
import { encodeModeldFrame, decodeModeldFrame, MODELD_MAX_FRAME } from "../wire/modeld-wire.ts";
import { parseContextCall, CONTEXT_PAGE_CHARS } from "../wire/context-wire.ts";
import { requestModeld } from "./modeld-client.node.ts";
import { hostEpochFromFacts } from "./modeld-produce.node.ts";
import { createNativeContextOwner, type NativeContextCapture, type NativeContextOwner } from "./context-maintenance.ts";
import type { HostBinding } from "./host-binding.ts";
import type { CompileReceipt } from "./compile-receipt.ts";
import type { HostCompactRequest } from "@grokbox/runtime-kernel/contract";
import type { HostWitnessNote } from "@grokbox/runtime-kernel/host-health";
import { recordHostManagedFailure } from "./session.ts";
import { appendHostJournal } from "./terminal-journal.node.ts";
import { runtimeBuildInfo } from "@grokbox/runtime-kernel/contract";

const turns = new Map<string, { selection: SelectionIdentity; policy?: CapturedContextPolicy; windowTokens?: number }>();
const key = (agentId: string, turnId: string) => `${agentId}\n${turnId}`;
export function registerHostContextTurn(selection: SelectionIdentity, turnId: string): void {
  const id = key(selection.agentId, turnId);
  if (!turns.has(id) && turns.size >= 256) turns.delete(turns.keys().next().value!);
  turns.set(id, { selection: { ...selection } });
}
export function hostContextWindow(agentId: string, turnId: string): number | undefined { return turns.get(key(agentId, turnId))?.windowTokens; }

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
function write(socket: Socket, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.destroyed) { reject(new ContextFailure("cancelled")); return; }
    socket.write(encodeModeldFrame(value), error => error ? reject(error) : resolve());
  });
}
function abortable<A>(promise: Promise<A>, signal: AbortSignal): Promise<A> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(new ContextFailure("cancelled")); };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    promise.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
  });
}

/** One locally owned socket and native capability; no retry or provider access. */
export async function maintainHostContext(runRoot: string, request: ContextMaintenanceRequest, owner: NativeContextOwner,
  signal?: AbortSignal): Promise<{ receipt: ContextMaintenanceReceipt; policy: CapturedContextPolicy }> {
  const controller = new AbortController();
  const socket = createConnection(join(runRoot, "modeld.sock"));
  let paged = "", offset = 0, sequence = 0, buffer = Buffer.alloc(0), done = false, nativePending = false;
  const abort = () => { controller.abort(); owner.cancel(); socket.destroy(); };
  const disconnected = () => { if (!done && nativePending) abort(); };
  socket.on("close", disconnected); socket.on("end", disconnected);
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, request.deadlineMs);
  if (signal?.aborted) abort();
  try {
    await abortable(new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); }), controller.signal);
    await write(socket, { version: WIRE_VERSION, method: "maintain-context", request });
    for await (const data of socket) {
      if (buffer.length + data.length > MODELD_MAX_FRAME + 4) throw new ContextFailure("context_material_too_large");
      buffer = Buffer.concat([buffer, data]);
      for (;;) {
        const decoded = decodeModeldFrame(buffer);
        if (!decoded) break;
        if ("error" in decoded) throw new ContextFailure("context_material_invalid");
        buffer = Buffer.from(decoded.rest);
        const value = decoded.value;
        if (object(value) && value.method === "context-terminal") {
          if (value.version !== WIRE_VERSION || buffer.length) throw new ContextFailure("context_material_invalid");
          if (value.ok !== true) throw contextFailure({ code: value.error }, "not_admitted");
          if (value.operationId !== request.operationId || !object(value.receipt) || value.receipt.operationId !== request.operationId
            || value.receipt.rootId !== request.rootId || !object(value.policy) || value.policy.revision !== value.receipt.policyRevision) throw new ContextFailure("context_material_invalid");
          const receipt = parseContextReceipt(value.receipt);
          done = true;
          return { receipt, policy: value.policy as unknown as CapturedContextPolicy };
        }
        const call = parseContextCall(value, request.operationId, sequence++);
        try {
          if (call.action === "page") {
            if (call.offset !== offset || offset >= paged.length) throw new ContextFailure("context_material_invalid");
          } else {
            let result: unknown;
            nativePending = true;
            try {
              if (call.action === "activity-start") { await abortable(owner.startActivity(), controller.signal); result = true; }
              else if (call.action === "authorize") result = owner.authorize();
              else if (call.action === "inspect") result = owner.inspect();
              else if (call.action === "preview") result = await abortable(owner.preview(call.candidate!), controller.signal);
              else if (call.action === "commit") result = await abortable(owner.commit(call.candidate!), controller.signal);
              else result = owner.readCommit() ?? null;
            } finally { nativePending = false; }
            paged = JSON.stringify(result); offset = 0;
            if (Buffer.byteLength(paged) > CONTEXT_MATERIAL_MAX_BYTES) throw new ContextFailure("context_material_too_large");
          }
          const chunk = paged.slice(offset, offset + CONTEXT_PAGE_CHARS); offset += chunk.length;
          await write(socket, { version: WIRE_VERSION, method: "context-result", operationId: request.operationId, sequence: call.sequence,
            chunk, more: offset < paged.length });
          if (offset === paged.length) { paged = ""; offset = 0; }
        } catch (error) {
          await write(socket, { version: WIRE_VERSION, method: "context-result", operationId: request.operationId, sequence: call.sequence,
            error: contextFailure(error, "context_material_invalid").code });
        }
      }
    }
    throw new ContextFailure(controller.signal.aborted ? "cancelled" : "commit_unknown");
  } catch (error) {
    // Socket abort can win the race with native commit/checkpoint completion.
    // Once the native writer began, do not report it as a safely cancelled
    // pre-write operation or let its waiting user run consume a partial root.
    if (owner.hasPublicationStarted()) throw new ContextFailure("commit_unknown");
    throw error;
  } finally {
    clearTimeout(timer); signal?.removeEventListener("abort", abort);
    socket.off("close", disconnected); socket.off("end", disconnected);
    if (!done) { controller.abort(); owner.cancel(); }
    socket.destroy();
    await owner.close();
  }
}

export type HostContextClientOptions = { runRoot: string; durableRoot?: string; binding?: HostBinding; compile?: CompileReceipt; mode: string; witness?: (note: HostWitnessNote) => void };
export function hostContextClient(options: HostContextClientOptions) {
  return (raw: unknown, valid: () => boolean, manualOperationId?: string) => {
    if (options.mode !== "route" || !object(raw) || typeof raw.agentId !== "string" || typeof raw.turnId !== "string") return undefined;
    const turn = turns.get(key(raw.agentId, raw.turnId));
    if (!turn) return undefined; // Unassigned/native-only sessions keep their own behavior.
    let observedServiceEpoch: string | undefined;
    const makeOwner = () => {
      if (!options.binding || !options.compile || !object(raw.config) || !object(raw.ctx) || !object(raw.stateHandler)
        || !object(raw.rootPromptExecutor) || !object(raw.orchestrator) || manualOperationId === undefined && typeof raw.invocationId !== "string"
        || typeof raw.normalizeContext !== "function" || typeof raw.contextFixedMessages !== "function"
        || typeof raw.contextTools !== "function" || typeof raw.contextCheckpoint !== "function") throw new ContextFailure("capability_unqualified");
      return createNativeContextOwner({ orchestrator: raw.orchestrator, ctx: raw.ctx, stateHandler: raw.stateHandler,
        rootPromptExecutor: raw.rootPromptExecutor, interactionListener: raw.interactionListener, config: raw.config,
        requestContext: raw.requestContext, resourceAccessor: raw.resourceAccessor, ...(manualOperationId === undefined ? { invocationId: raw.invocationId as string } : {}),
        turnId: raw.turnId as string, agentId: raw.agentId as string, sessionId: typeof raw.config.agentSessionId === "string" ? raw.config.agentSessionId : "",
        modelId: turn.selection.modelId,
        normalize: raw.normalizeContext as NativeContextCapture["normalize"], fixedMessages: raw.contextFixedMessages as NativeContextCapture["fixedMessages"],
        tools: raw.contextTools as NativeContextCapture["tools"], checkpoint: raw.contextCheckpoint as NativeContextCapture["checkpoint"],
        ...(typeof raw.contextActivity === "function" ? { activity: raw.contextActivity as NativeContextCapture["activity"] } : {}), valid,
        ...(options.durableRoot || options.witness ? { observe: async event => {
          if (event.state === "checkpoint_observed" || event.state === "commit_unknown") {
            try { options.witness?.({ capability: "context", stage: "checkpoint-settled", outcome: event.state === "checkpoint_observed" ? "returned" : "threw", agentId: raw.agentId as string, turnId: raw.turnId as string, stepId: raw.invocationId as string }); } catch { /* Keep the actual native commit outcome. */ }
          }
          if (options.durableRoot) await appendHostJournal(options.runRoot, { name: "host_context_observation", schemaVersion: 1, at: new Date().toISOString(),
            hostGenerationId: options.binding!.generationId, agentId: raw.agentId, turnId: raw.turnId,
            ...(manualOperationId === undefined ? { stepId: raw.invocationId } : {}),
            ...(observedServiceEpoch ? { serviceEpoch: observedServiceEpoch } : {}),
            ...event, basis: "native_context_owner", build: runtimeBuildInfo() }, { configurationRoot: options.durableRoot });
        } } : {}) });
    };
    const run = async (recovery?: HostCompactRequest, deadlineMs = 180000) => {
      const owner = makeOwner();
      try {
        const health = (await requestModeld(options.runRoot, { version: WIRE_VERSION, method: "health" }))[0];
        if (!object(health) || typeof health.serverGeneration !== "string") throw new ContextFailure("capability_unqualified");
        observedServiceEpoch = health.serverGeneration;
        const before = owner.inspect();
        const request: ContextMaintenanceRequest = { operationId: manualOperationId ?? (recovery ? `overflow:${recovery.recoveryNonce}` : randomUUID()),
          hostEpoch: hostEpochFromFacts({ binding: options.binding!, profileId: "t21-state-root", bridgeDigest: options.compile!.transformedSha256 }),
          serviceEpoch: { incarnationId: health.serverGeneration }, agentId: raw.agentId as string,
          sessionId: object(raw.config) && typeof raw.config.agentSessionId === "string" ? raw.config.agentSessionId : "",
          rootId: before.rootId, rootRevision: before.rootRevision, selection: turn.selection,
          ...(manualOperationId === undefined ? { parent: { turnId: raw.turnId as string, stepId: raw.invocationId as string,
            ...(recovery ? { bindingId: recovery.tuple.bindingId } : {}) } } : { confirmed: true }),
          reason: manualOperationId !== undefined ? "manual" : recovery ? "overflow" : "preflight",
          ...(recovery ? { recoveryNonce: recovery.recoveryNonce } : {}), deadlineMs };
        const result = await maintainHostContext(options.runRoot, request, owner, object(raw.ctx) ? raw.ctx.signal as AbortSignal : undefined);
        turn.policy = result.policy; turn.windowTokens = result.receipt.budget.windowTokens;
        return result.receipt;
      } catch (error) {
        await owner.close(); recordHostManagedFailure(error); throw error;
      }
    };
    return { preflight: () => run(), recover: (request: HostCompactRequest, deadlineMs: number) => run(request, deadlineMs),
      ...(manualOperationId !== undefined ? { manual: () => run(undefined, 120000) } : {}) };
  };
}
