import { CurrentStateFailure, applicationObservation, copyNativeMaterial, continuityStorePolicy, decodeCurrentStateMaterial,
  encodeCurrentStateMaterial, initializationDigest, nativeCurrentHead, nativeQualification,
  preparedCurrentState, type NativeCurrentStatePort, type NativeCurrentHead, type NativeQualification,
  type CurrentStateRpcRequest, type InitializationAttempt } from "@grokbox/runtime-kernel/continuity";

export type CurrentStateTransport = (request: CurrentStateRpcRequest) => Promise<unknown>;
const fail = (): never => { throw new CurrentStateFailure("native_unavailable"); };
/** Finite typed client for the existing authenticated Gateway. A single remote
 * initialize call owns its native lease to completion; the controller does not
 * hold a worker lock across network calls. Transport uncertainty stays unknown. */
export function createCurrentStateClient(input: { call: CurrentStateTransport; qualification: NativeQualification }) {
  const qualification = nativeQualification(input.qualification);
  const request = async (action: CurrentStateRpcRequest["action"], agentId: string, payload?: unknown, confirm = false): Promise<any> => {
    const response = await input.call({ version: 1, action, agentId, ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
      ...(confirm ? { confirm: true } : {}) }) as any;
    if (!response || response.ok !== true) {
      const codes = ["native_unavailable", "invalid_request", "qualification_mismatch", "source_changed", "not_prepared", "ownership_unconfirmed",
        "policy_changed", "material_invalid", "commit_unknown", "cleanup_unknown", "cancelled", "operation_conflict"] as const;
      if (codes.includes(response?.error?.code)) throw new CurrentStateFailure(response.error.code);
      return fail();
    }
    return response.data;
  };
  const head = async (agentId: string) => {
    const result = await request("head", agentId), value = nativeCurrentHead(result?.head);
    if (value.agentId !== agentId || value.hostSourceSha !== qualification.hostSourceSha || value.nativeSchema !== qualification.nativeSchema
      || typeof result.policyRevision !== "string" || !/^[a-f0-9]{64}$/.test(result.policyRevision)) return fail();
    return { head: value, policyRevision: result.policyRevision as string };
  };
  const publicRequest = (attempt: InitializationAttempt) => ({ operationId: attempt.operationId, effectId: attempt.effectId, snapshot: attempt.snapshot,
    expected: attempt.expected, policyRevision: attempt.policyRevision });
  const observe = async (attempt: InitializationAttempt) => applicationObservation(await request("observe", attempt.expected.agentId, { request: publicRequest(attempt) }), attempt);
  const port: NativeCurrentStatePort = { qualification,
    capture: async expected => {
      let closed = false;
      return { readHead: async () => { if (closed) return fail(); return (await head(expected.agentId)).head; },
        readMaterial: async limits => {
          if (closed) return fail();
          const result = await request("capture", expected.agentId, { expected, limits });
          return decodeCurrentStateMaterial(result.material);
        }, release: async () => { closed = true; } };
    },
    initialize: async attempt => {
      let material: ReturnType<typeof encodeCurrentStateMaterial> | undefined;
      let completed: ReturnType<typeof applicationObservation> | undefined;
      let closed = false;
      const valid = () => { if (closed) return fail(); };
      return { readHead: async () => { valid(); return (await head(attempt.expected.agentId)).head; },
        prepare: async (raw, received) => {
          valid(); if (received.inputDigest !== initializationDigest(publicRequest(attempt))) return fail();
          material = encodeCurrentStateMaterial(copyNativeMaterial(raw, continuityStorePolicy()));
          return preparedCurrentState(await request("preview", attempt.expected.agentId, { request: publicRequest(attempt), material }), attempt);
        },
        commit: async received => {
          valid(); if (!material || received.inputDigest !== attempt.inputDigest) return fail();
          const result = await request("initialize", attempt.expected.agentId, { request: publicRequest(attempt), material }, true);
          completed = applicationObservation(result.observation, attempt);
          if (completed.state !== "applied") throw new CurrentStateFailure("commit_unknown");
        },
        reopen: async () => {
          valid(); if (completed?.state !== "applied") throw new CurrentStateFailure("commit_unknown");
          return completed.current;
        },
        application: async received => { valid(); return observe(received); },
        // Server call owns/releases the actual native lease. A lost HTTP reply is
        // never converted into proof that its remote write was cancelled.
        release: async () => { closed = true; material = undefined; },
      };
    }, observeApplication: observe,
  };
  return { port, head,
    activate: (attempt: InitializationAttempt, current: NativeCurrentHead) => request("activate", current.agentId, { request: publicRequest(attempt), current }, true) };
}
