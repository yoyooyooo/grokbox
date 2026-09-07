import { randomUUID } from "node:crypto";
import { sha256Text } from "./hash.ts";
import { cloneJson, envelopeHasImage, parseModelEnvelope, type ModelEnvelope } from "./envelope.ts";
import { bindingMismatch, parseHostBinding, type HostBinding } from "./modeld-binding.ts";
import { boundedText } from "./observation.ts";
import { parseModelsFile, resolveAssignment, type ModelRecord, type ModelsFile } from "./models.ts";
import type { StreamPart } from "./session.ts";

export type AdmissionAuthority = { state: "committed"; host: HostBinding } | { state: "pending" | "disabled" | "unavailable" };
export type ModeldPorts = {
  loadModels: () => ModelsFile | Promise<ModelsFile>;
  authority: () => AdmissionAuthority | Promise<AdmissionAuthority>;
  /** Only an admitted fake/provider adapter may supply this hook. Stub never calls it. No secret in its result. */
  credentialFingerprint?: (model: Readonly<ModelRecord>, signal: AbortSignal) => string | Promise<string>;
};
export type ModelPin = {
  readonly model: Readonly<ModelRecord>;
  readonly assignment: "main" | "agent";
  readonly fingerprint: string;
  readonly credentialFingerprint: string | null;
};
export type ModeldDriver = {
  accepts: (model: Readonly<ModelRecord>) => boolean;
  complete: (input: { pin: ModelPin; envelope: ModelEnvelope; invocationId: string; agentId: string; signal: AbortSignal }) => StreamPart[] | Promise<StreamPart[]>;
};
export type AdmitRequest = {
  serverGeneration: string;
  host: HostBinding;
  invocationId: string;
  turnId: string;
  agentId: string;
  envelope: ModelEnvelope;
};
export type AdmissionFailureCode = "wrong-server-generation" | "wrong-generation" | "wrong-activation" | "wrong-source" | "wrong-identity"
  | "invalid-binding" | "missing-ids" | "invalid-envelope" | "unsupported-content" | "disabled" | "authority-unavailable"
  | "admission-timeout" | "missing-assignment" | "invalid-models" | "wrong-model" | "credential-unavailable"
  | "conflict" | "disconnected" | "expired" | "capacity" | "driver-failed" | "stopped";
export type AdmitResult = { ok: true; dispatched: boolean; modelId: string; assignment: "main" | "agent"; fingerprint: string; parts: StreamPart[] }
  | { ok: false; code: AdmissionFailureCode; userVisible: true };
export type InvocationState = "pending" | "running" | "terminal" | "unknown";
type Row = {
  host: HostBinding; hash: string | null; state: InvocationState; expiresAt: number;
  controller: AbortController; result?: AdmitResult; work?: Promise<AdmitResult>;
  timer?: ReturnType<typeof setTimeout>; pinKey?: string; code?: AdmissionFailureCode;
};
const fail = (code: AdmissionFailureCode): AdmitResult => ({ ok: false, code, userVisible: true });
function frozen<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) frozen(child); Object.freeze(value); }
  return value;
}
function abortable<T>(work: T | Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(new Error("cancelled")); };
    Promise.resolve(work).then((value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error) => { signal.removeEventListener("abort", abort); reject(error); });
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  });
}

/** One admission/pin/dispatch owner, also used by the Unix server. Ports choose dependency reality, not policy. */
export function createModeld(input: ModeldPorts & {
  driver: ModeldDriver; now?: () => number; budgetMs?: number; idleTtlMs?: number; maxRecords?: number; pollMs?: number;
}) {
  const serverGeneration = randomUUID();
  const registry = new Map<string, Row>();
  const pins = new Map<string, { value: Promise<ModelPin>; users: number }>();
  const now = input.now ?? Date.now;
  const limit = (value: number | undefined, fallback: number, ceiling: number) => {
    const n = value ?? fallback;
    if (!Number.isSafeInteger(n) || n < 1 || n > ceiling) throw new Error("invalid modeld limit");
    return n;
  };
  const budget = limit(input.budgetMs, 500, 5000);
  const ttl = limit(input.idleTtlMs, 30_000, 300_000);
  const max = limit(input.maxRecords, 1024, 16_384);
  const poll = limit(input.pollMs, 5, 1000);
  let currentHost: HostBinding | undefined;
  let stopped = false;
  let dispatches = 0;
  const keyOf = (host: HostBinding, id: string) => `${host.generationId}:${id}`;
  function releasePin(row: Row) {
    if (!row.pinKey) return;
    const entry = pins.get(row.pinKey);
    if (entry && --entry.users === 0) pins.delete(row.pinKey);
    row.pinKey = undefined;
  }
  function cancel(row: Row, code: AdmissionFailureCode) {
    row.code = code; row.state = "unknown"; row.result = undefined; row.work = undefined;
    clearTimeout(row.timer); releasePin(row); row.controller.abort();
  }
  function arm(row: Row, ms: number, code: AdmissionFailureCode) {
    clearTimeout(row.timer); row.expiresAt = now() + ms;
    row.timer = setTimeout(() => cancel(row, code), ms); row.timer.unref?.();
  }
  function sweep() {
    for (const row of registry.values()) if (row.state !== "unknown" && now() >= row.expiresAt) cancel(row, "expired");
  }
  async function verify(row: Row): Promise<AdmissionFailureCode | null> {
    while (!row.controller.signal.aborted) {
      let fact: AdmissionAuthority;
      try { fact = await abortable(input.authority(), row.controller.signal); }
      catch { return row.code ?? "authority-unavailable"; }
      if (row.controller.signal.aborted) return row.code ?? "disconnected";
      if (fact.state === "disabled") return "disabled";
      if (fact.state === "unavailable") return "authority-unavailable";
      if (fact.state === "committed") {
        let host: HostBinding;
        try { host = parseHostBinding(fact.host); } catch { return "authority-unavailable"; }
        if (currentHost && bindingMismatch(currentHost, host)) {
          // Canonical generation replacement retires old work and frees its tombstones. Never migrate pins.
          for (const [key, old] of registry) if (bindingMismatch(old.host, host)) { cancel(old, "wrong-generation"); registry.delete(key); }
        }
        currentHost = host;
        return bindingMismatch(row.host, host);
      }
      await abortable(new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, poll);
        timer.unref?.();
      }), row.controller.signal).catch(() => undefined);
    }
    return row.code ?? "disconnected";
  }
  async function pin(row: Row, request: AdmitRequest): Promise<ModelPin> {
    const key = JSON.stringify([request.host.generationId, request.agentId, request.turnId]);
    row.pinKey = key;
    let entry = pins.get(key);
    if (!entry) {
      // Reserve before the first await: simultaneous steps cannot load two configurations for one turn.
      const value = (async (): Promise<ModelPin> => {
        let file: ModelsFile;
        try { file = parseModelsFile(cloneJson(await abortable(input.loadModels(), row.controller.signal))); }
        catch { throw new Error("invalid-models"); }
        let model: ModelRecord;
        try { model = frozen(cloneJson(resolveAssignment(file, request.agentId)) as ModelRecord); }
        catch { throw new Error("missing-assignment"); }
        if (!input.driver.accepts(model)) throw new Error("wrong-model");
        if (envelopeHasImage(request.envelope) && !model.capabilities.vision) throw new Error("unsupported-content");
        const denied = await verify(row);
        if (denied) throw new Error(denied);
        let credentialFingerprint: string | null = null;
        if (model.apiKeyRef) {
          if (!input.credentialFingerprint) throw new Error("credential-unavailable");
          try { credentialFingerprint = await abortable(input.credentialFingerprint(model, row.controller.signal), row.controller.signal); }
          catch { throw new Error("credential-unavailable"); }
          if (!/^[a-f0-9]{64}$/.test(credentialFingerprint)) throw new Error("credential-unavailable");
        }
        return frozen({ model, assignment: Object.hasOwn(file.assignments.agents, request.agentId) ? "agent" : "main",
          credentialFingerprint, fingerprint: sha256Text(JSON.stringify([model, credentialFingerprint])) });
      })();
      entry = { value, users: 0 }; pins.set(key, entry);
    }
    entry.users += 1;
    return await entry.value;
  }
  async function execute(row: Row, request: AdmitRequest): Promise<AdmitResult> {
    const signal = row.controller.signal;
    try {
      let denied = await verify(row);
      if (denied) return fail(denied);
      let pinned: ModelPin;
      try { pinned = await abortable(pin(row, request), signal); }
      catch (error) {
        // Only the kernel's bounded enums leave this boundary; never a port error or model/credential body.
        const allowed: readonly string[] = ["invalid-models", "missing-assignment", "wrong-model", "unsupported-content", "credential-unavailable",
          "wrong-generation", "wrong-activation", "wrong-source", "wrong-identity", "disabled", "authority-unavailable"];
        return fail(row.code ?? (error instanceof Error && allowed.includes(error.message) ? error.message as AdmissionFailureCode : "credential-unavailable"));
      }
      if (envelopeHasImage(request.envelope) && !pinned.model.capabilities.vision) return fail("unsupported-content");
      denied = await verify(row); // after configuration/fingerprint awaits; no await between this check and the effect
      if (denied || signal.aborted) return fail(denied ?? row.code ?? "disconnected");
      row.state = "running"; arm(row, ttl, "expired");
      dispatches += 1;
      let parts: StreamPart[];
      try { parts = await abortable(input.driver.complete({ pin: pinned, envelope: request.envelope,
        invocationId: request.invocationId, agentId: request.agentId, signal }), signal); }
      catch { return fail(row.code ?? "driver-failed"); }
      if (signal.aborted) return fail(row.code ?? "disconnected");
      // Drivers are trusted adapters. Snapshot their bounded output; no mutable driver array retained in the ledger.
      try { parts = frozen(cloneJson(parts) as StreamPart[]); } catch { return fail("driver-failed"); }
      return { ok: true, dispatched: true, modelId: pinned.model.id, assignment: pinned.assignment, fingerprint: pinned.fingerprint, parts };
    } finally { releasePin(row); }
  }
  async function admit(raw: AdmitRequest, clientSignal?: AbortSignal): Promise<AdmitResult> {
    if (stopped) return fail("stopped");
    if (raw.serverGeneration !== serverGeneration) return fail("wrong-server-generation");
    let host: HostBinding; let envelope: ModelEnvelope;
    try { host = parseHostBinding(raw.host); } catch { return fail("invalid-binding"); }
    if (![raw.invocationId, raw.turnId, raw.agentId].every((id) => boundedText(id, 128))) return fail("missing-ids");
    try { envelope = parseModelEnvelope(raw.envelope); } catch { return fail("invalid-envelope"); }
    const request = { ...raw, host, envelope };
    const hash = sha256Text(JSON.stringify([host, request.invocationId, request.agentId, request.turnId, envelope]));
    sweep();
    const key = keyOf(host, request.invocationId);
    const existing = registry.get(key);
    if (existing) {
      if (existing.hash !== null && existing.hash !== hash) return fail("conflict");
      if (existing.state === "unknown") return fail(existing.code ?? "disconnected");
      const result = await existing.work!;
      if (existing.controller.signal.aborted) return fail(existing.code ?? "disconnected");
      // A cached response is not authority to dispatch or succeed after deactivation/replacement.
      const denied = await verify(existing);
      if (denied) return fail(denied);
      return result.ok ? { ...result, dispatched: false } : result;
    }
    if (registry.size >= max) {
      if (!currentHost || currentHost.generationId === host.generationId) return fail("capacity");
      const probe: Row = { host, hash, state: "pending", expiresAt: now() + budget, controller: new AbortController() };
      arm(probe, budget, "admission-timeout");
      const denied = await verify(probe); clearTimeout(probe.timer);
      return denied ? fail(denied) : await admit(request, clientSignal);
    }
    const row: Row = { host, hash, state: "pending", expiresAt: now() + budget, controller: new AbortController() };
    registry.set(key, row); arm(row, budget, "admission-timeout");
    const disconnected = () => cancel(row, "disconnected");
    if (clientSignal?.aborted) disconnected(); else clientSignal?.addEventListener("abort", disconnected, { once: true });
    row.work = execute(row, request).then((result) => {
      clientSignal?.removeEventListener("abort", disconnected);
      if (row.state === "unknown") return fail(row.code ?? "disconnected");
      row.state = "terminal"; row.result = frozen(result); arm(row, ttl, "expired");
      return row.result;
    }, () => { clientSignal?.removeEventListener("abort", disconnected); cancel(row, "driver-failed"); return fail("driver-failed"); });
    return await row.work;
  }
  function disconnect(input: Pick<AdmitRequest, "serverGeneration" | "host" | "invocationId">): AdmitResult | { ok: true } {
    if (stopped) return fail("stopped");
    if (input.serverGeneration !== serverGeneration) return fail("wrong-server-generation");
    let host: HostBinding;
    try { host = parseHostBinding(input.host); } catch { return fail("invalid-binding"); }
    if (!boundedText(input.invocationId, 128)) return fail("missing-ids");
    const key = keyOf(host, input.invocationId);
    let row = registry.get(key);
    if (row && bindingMismatch(row.host, host)) return fail("conflict");
    if (!row) {
      if (registry.size >= max) return fail("capacity");
      row = { host, hash: null, state: "unknown", expiresAt: now(), controller: new AbortController() }; registry.set(key, row);
    }
    cancel(row, "disconnected");
    return { ok: true };
  }
  return {
    serverGeneration, admit, disconnect, sweep,
    stop() { if (stopped) return; stopped = true; for (const row of registry.values()) cancel(row, "stopped"); registry.clear(); pins.clear(); },
    stats: () => ({ dispatches, records: registry.size, pins: pins.size }),
    get: (host: HostBinding, id: string) => { const row = registry.get(keyOf(host, id)); return row ? { state: row.state, code: row.code } : undefined; },
  };
}
export type ModelD = ReturnType<typeof createModeld>;

/** Promise facade over the modeld C1 Effect in `modeld-credentials.ts`. Never put the secret into pin/IPC. */
export type SecretResolver = (ref: string, signal?: AbortSignal) => Promise<string>;
export function createFileEnvSecretResolver(env: NodeJS.Dict<string>): SecretResolver {
  return (ref, signal) => import("./modeld-credentials.ts").then((mod) => mod.materializeApiKeyRef(ref, env, signal));
}
