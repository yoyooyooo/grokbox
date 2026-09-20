import { Effect } from "effect";
import { UUID, botIdFromRef, normalizeSetupRequest, routineIdentity, routineReference, setupKind, ManagementClientError,
  type SetupRequest, type SetupOperation, type SetupKind, type NotificationSettingsView, type PublicRoutine, type RoutineList } from "@grokbox/client/contract";
import { ConfigError, effectiveOps, configChangeFingerprint, type ConfigChange } from "@grokbox/runtime-kernel/config";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { RoutineError, RoutineProvisionError, parseRoutineBlueprint, provisionFingerprint, type ProvisionLookup } from "@grokbox/runtime-kernel/routines";
import { OpsPairingError } from "@grokbox/runtime-kernel/observation";
import { openConfigStore, rootConfigLayout, openOpsBindings, openRoutineProvisionStore, runRoutineProvisionCommand,
  runOpsPairing, changeManagedRoutine, prepareOpsReceiverBlueprint, type RoutineAccess } from "@grokbox/box-runtime/runtime";
import { HttpFailure, requireCapability, type Principal } from "./access.ts";

export type NotificationSetupDomain = { root: string; installationId: string; routineAccess?: (signal: AbortSignal) => RoutineAccess };
const no = (code: "not_found" | "revision_conflict" | "idempotency_conflict" | "operation_unknown" | "source_unavailable" | "source_changed", message: string): never => {
  throw new HttpFailure(code === "not_found" ? 404 : code === "source_unavailable" ? 503 : 409, code, message);
};
function errorView(error: unknown): HttpFailure {
  if (error instanceof HttpFailure) return error;
  if (error instanceof ManagementClientError) return new HttpFailure(error.code === "wrong_installation" ? 409 : 400, error.code, error.message);
  if (error instanceof ConfigError) return new HttpFailure(error.code === "config_commit_unknown" ? 409 : error.code === "config_conflict" ? 409 : 503,
    error.code === "config_commit_unknown" ? "operation_unknown" : error.code === "config_conflict" ? "revision_conflict" : "source_unavailable", "The notification configuration operation requires inspection of its original receipt.");
  if (error instanceof RoutineError || error instanceof RoutineProvisionError || error instanceof OpsPairingError) {
    const r = error.reason;
    if (["invalid_input", "confirmation_required"].includes(r)) return new HttpFailure(400, "invalid_input", "An exact target, revision and explicit confirmation are required.");
    if (r === "capacity") return new HttpFailure(507, "store_full", "The setup domain is at capacity; unresolved operations have not been discarded.");
    if (r === "outcome_unknown") return new HttpFailure(409, "operation_unknown", "The setup outcome is uncertain. Inspect the original operation; do not issue a replacement request.");
    if (r === "operation_conflict") return new HttpFailure(409, "idempotency_conflict", "The request ID or target revision conflicts with a retained setup operation.");
    if (r === "revision_conflict") return new HttpFailure(409, "revision_conflict", "The Routine or binding changed. Refresh the target while preserving the draft.");
    if (r === "key_busy" || r === "pairing_busy") return new HttpFailure(409, "operation_unknown", "An unresolved operation already protects this target. Query it before another change.");
    if (r === "scope_changed" || r === "generation_changed") return new HttpFailure(409, "source_changed", "The source generation or configured target changed during setup.");
    if (r === "not_recorded" || r === "not_found_in_window") return new HttpFailure(404, "not_found", "The exact object was not found in this domain's retained or native window.");
  }
  return new HttpFailure(503, "source_unavailable", "The setup source is unavailable. No alternate source or credential was selected.");
}
const io = <A>(run: (signal: AbortSignal) => Promise<A>) => Effect.tryPromise({ try: run, catch: errorView });
/** An admitted setup owns its native transport and final local publication.
 * Closing the Server cancels and then awaits it, rather than detaching a Promise. */
const owned = <A>(run: (signal: AbortSignal) => Promise<A>) => Effect.scoped(Effect.gen(function* () {
  const task = yield* Effect.acquireRelease(Effect.sync(() => {
    const controller = new AbortController(), promise = run(controller.signal); void promise.catch(() => undefined);
    return { controller, promise };
  }), task => Effect.promise(async () => { task.controller.abort(); await task.promise.catch(() => undefined); }));
  return yield* io(() => task.promise);
}));
export const setupOperationKey = (installationId: string, principalId: string, kind: SetupKind, scope: string, requestId: string) =>
  sha256Text(canonicalJson(["notification-setup-v1", installationId, principalId, kind, scope, requestId]));
function identity(domain: NotificationSetupDomain, principal: Principal, kind: SetupKind, scope: string, requestId: string) {
  const key = setupOperationKey(domain.installationId, principal.id, kind, scope, requestId);
  return { key, requestId, operationRef: `setup-operation:${domain.installationId}:${kind}:${scope}:${key}` };
}
function base(kind: SetupKind, action: SetupRequest["action"], id: ReturnType<typeof identity>, targetRef: string): SetupOperation {
  return { version: 1, kind, action, requestId: id.requestId, operationRef: id.operationRef, targetRef,
    resultRef: null, state: "unknown", beforeRevision: null, revision: null, evidence: "not-verified",
    nativeCompareAndSwap: false, webhookInvoked: false, grantsPermission: false };
}
function scopedBot(domain: NotificationSetupDomain, botId: string) { return `bot:${domain.installationId}:${botId}`; }
function native(domain: NotificationSetupDomain, signal: AbortSignal): RoutineAccess {
  if (!domain.routineAccess) return no("source_unavailable", "No qualified local Routine adapter is connected.");
  return domain.routineAccess(signal);
}
async function settingsView(domain: NotificationSetupDomain): Promise<NotificationSettingsView> {
  const snapshot = await openConfigStore(rootConfigLayout(domain.root)).read(), ops = effectiveOps(snapshot.document.ops);
  const notifications = ops.notifications as Record<string, unknown>, routing = ops.routing as Record<string, unknown>;
  return { revision: snapshot.revision, mode: notifications.mode as "off" | "actionable-user", installationBudget: Number(notifications.maxAutomaticWakeupsPerDay),
    selectedAlias: String(routing.defaultTarget), advancedRouting: routing.enabled === true, opsEnabled: ops.enabled === true,
    targets: Object.entries(ops.targets as Record<string, Record<string, unknown>>).map(([alias, target]) => ({ alias,
      botRef: typeof target.agentId === "string" ? scopedBot(domain, target.agentId) : null, routineKey: typeof target.routineKey === "string" ? target.routineKey : null,
      targetBudget: Number(target.maxAutomaticWakeupsPerDay ?? notifications.maxAutomaticWakeupsPerDay), enabled: target.enabled === true })), source: "configuration", grantsPermission: false };
}
function configurationCommand(request: Extract<SetupRequest, { action: "settings" }>, id: ReturnType<typeof identity>, installationId: string): ConfigChange {
  const s = request.settings;
  return { kind: "notification-settings", operationId: id.key, scope: "box", confirm: true, expectedRevision: request.expectedRevision,
    settings: { alias: s.alias, agentId: botIdFromRef(s.botRef, installationId), routineKey: s.routineKey, mode: s.mode,
      installationBudget: s.installationBudget, targetBudget: s.targetBudget } };
}
function provisionView(domain: NotificationSetupDomain, botId: string, id: ReturnType<typeof identity>, row: ProvisionLookup): SetupOperation {
  const common = base("routine", "apply", id, scopedBot(domain, botId));
  if (row.state === "retired") return { ...common, state: "retired", evidence: "retired" };
  const succeeded = row.state === "observed";
  return { ...common, beforeRevision: row.beforeRevision, revision: row.observedRevision,
    resultRef: row.nativeId ? routineReference(domain.installationId, botId, row.nativeId) : null,
    state: succeeded ? "succeeded" : "unknown", evidence: succeeded ? "disabled-definition-observed" : "not-verified" };
}
export async function setupLookup(domain: NotificationSetupDomain, principal: Principal, kind: SetupKind, scope: string, requestId: string): Promise<SetupOperation> {
  const id = identity(domain, principal, kind, scope, requestId);
  if (kind === "settings") {
    const row = await openConfigStore(rootConfigLayout(domain.root)).operation(id.key);
    if (!row) return no("not_found", "No configuration receipt is recorded for this principal and request.");
    return { ...base(kind, "settings", id, `notification-settings:${domain.installationId}`), beforeRevision: row.beforeRevision, revision: row.phase === "committed" ? row.afterRevision : null,
      state: row.phase === "committed" ? "succeeded" : "unknown", evidence: row.phase === "committed" ? "configuration-committed" : "not-verified" };
  }
  if (kind === "pairing") {
    const row = await openOpsBindings(domain.root).pairingOperation(id.key);
    if (!row) return no("not_found", "No pairing receipt is recorded for this principal and request.");
    return { ...base(kind, "bind", id, routineReference(domain.installationId,row.agentId,row.routineId)), beforeRevision: row.beforeRevision, revision: row.revision,
      resultRef: `receiver:${domain.installationId}:${row.databaseId}:${row.bindingId}`, state: row.state, evidence: row.state === "succeeded" ? "credential-stored" : "not-verified" };
  }
  const store = openRoutineProvisionStore(domain.root), row = await store.read(scope, id.key);
  if (row) return provisionView(domain, scope, id, row);
  const state = await store.stateRecord(scope, id.key);
  if (!state) return no("not_found", "No Routine receipt is recorded for this principal and request.");
  const ref = routineReference(domain.installationId,scope,state.nativeId);
  return { ...base(kind,state.action,id,ref), resultRef: ref, beforeRevision: state.beforeRevision, revision: state.afterRevision,
    state: state.state === "observed" ? "succeeded" : "unknown", evidence: state.evidence };
}
async function apply(domain: NotificationSetupDomain, principal: Principal, request: SetupRequest, signal: AbortSignal): Promise<SetupOperation> {
  const kind = setupKind(request.action), botId = request.action === "apply" ? botIdFromRef(request.botRef, domain.installationId)
    : request.action === "settings" ? undefined : routineIdentity(request.routineRef, domain.installationId).botId;
  const scope = kind === "routine" ? botId! : "installation", id = identity(domain,principal,kind,scope,request.requestId);
  if (request.action === "settings") {
    const store = openConfigStore(rootConfigLayout(domain.root)), command = configurationCommand(request,id,domain.installationId), old = await store.operation(id.key);
    if (old && old.fingerprint !== sha256Text(configChangeFingerprint(command))) return no("idempotency_conflict", "This settings request ID belongs to different input.");
    if (!old) {
      signal.throwIfAborted();
      try { await Effect.runPromise(store.change(command), { signal }); }
      catch (error) {
        const retained = await store.operation(id.key).catch(() => no("operation_unknown", "The configuration publication cannot be verified; preserve the original request."));
        if (retained && retained.fingerprint === sha256Text(configChangeFingerprint(command))) return setupLookup(domain,principal,kind,scope,request.requestId);
        throw error;
      }
    }
    return setupLookup(domain,principal,kind,scope,request.requestId);
  }
  if (request.action === "apply") {
    const store = openRoutineProvisionStore(domain.root), command = { action: "apply" as const, agentId: botId!, operationId: id.key, confirmed: true as const,
      blueprint: parseRoutineBlueprint(request.blueprint), ...(request.expectedRevision ? { expectedRevision: request.expectedRevision } : {}) };
    const old = await store.read(botId!,id.key);
    if (old && old.fingerprint !== provisionFingerprint(command) || await store.stateRecord(botId!,id.key)) return no("idempotency_conflict", "This Routine request ID belongs to different input.");
    if (!old) await runRoutineProvisionCommand({ durableRoot: domain.root, command, native: native(domain,signal), signal });
    return setupLookup(domain,principal,kind,scope,request.requestId);
  }
  if (request.action === "reconcile") {
    const store = openRoutineProvisionStore(domain.root), original = await store.read(botId!,id.key);
    if (!original) return no("not_found", "Only a retained provision request can be reconciled; state-change history cannot be inferred from a matching current value.");
    if (original.state === "observed" || original.state === "retired") return setupLookup(domain,principal,kind,scope,request.requestId);
    const access = native(domain,signal), rid = routineIdentity(request.routineRef,domain.installationId).routineId;
    const observed = await access.list(botId!), selected = observed.catalog.routines.find(row => row.id === rid);
    if (!selected || selected.revision !== request.expectedRevision) return no("revision_conflict", "The selected reconciliation target changed.");
    await runRoutineProvisionCommand({ durableRoot: domain.root, command: { action:"reconcile",agentId:botId!,operationId:id.key,routineId:rid,confirmed:true },native:access,signal });
    return setupLookup(domain,principal,kind,scope,request.requestId);
  }
  if (request.action === "bind") {
    const owner = openOpsBindings(domain.root), digest = sha256Text(canonicalJson(request)), old = await owner.pairingOperation(id.key);
    if (old && old.requestDigest !== digest) return no("idempotency_conflict", "This pairing request ID belongs to different input.");
    if (!old) await runOpsPairing({ durableRoot: domain.root, command: { action: "bind", alias: request.alias,
      routineId: routineIdentity(request.routineRef,domain.installationId).routineId, expectedRevision: request.expectedRevision, operationId: id.key, confirmed: true },
      expectedBindingRevision: request.expectedBindingRevision, native: native(domain,signal), signal,
      management: { operationId: id.key, requestDigest: digest, databaseId: request.databaseId, agentId: botId! } });
    return setupLookup(domain,principal,kind,scope,request.requestId);
  }
  const retainedState = await openRoutineProvisionStore(domain.root).stateRecord(botId!,id.key);
  if (retainedState) {
    if (retainedState.fingerprint !== sha256Text(canonicalJson(request))) return no("idempotency_conflict", "This Routine request ID belongs to different input.");
    return setupLookup(domain,principal,kind,scope,request.requestId);
  }
  await changeManagedRoutine({ root: domain.root, operationId: id.key, agentId: botId!, nativeId: routineIdentity(request.routineRef,domain.installationId).routineId,
    action: request.action, expectedRevision: request.expectedRevision, fingerprint: sha256Text(canonicalJson(request)), native: native(domain,signal), signal });
  return setupLookup(domain,principal,kind,scope,request.requestId);
}
export function notificationSetup(domain: NotificationSetupDomain, principal: Principal, method: string, url: URL, input?: unknown) {
  return Effect.gen(function* () {
    const path = url.pathname;
    if (path === "/v1/setup-changes" && method === "POST") {
      const request = yield* Effect.try({ try: () => normalizeSetupRequest(input, domain.installationId), catch: errorView });
      yield* Effect.try({ try: () => requireCapability(principal, request.action === "settings" ? "notifications.write" : request.action === "bind" ? "notifications.bind" : "routines.write"), catch: errorView });
      if (url.search) return yield* Effect.fail(new HttpFailure(400,"invalid_input","Setup changes do not accept URL parameters."));
      return yield* owned(signal => apply(domain,principal,request,signal));
    }
    yield* Effect.try({ try: () => requireCapability(principal, path.startsWith("/v1/setup-operations/") ? "operations.read" : path.startsWith("/v1/routines") ? "routines.read" : "notifications.read"), catch: errorView });
    if (method !== "GET" || (url.search && path !== "/v1/routines")) return yield* Effect.fail(new HttpFailure(400,"invalid_input","Invalid setup query."));
    if (path === "/v1/notification-settings") return yield* io(() => settingsView(domain));
    const blueprint = /^\/v1\/notification-blueprint\/([a-z][a-z0-9_-]{0,31})$/.exec(path);
    if (blueprint) return yield* io(() => prepareOpsReceiverBlueprint({ durableRoot: domain.root, alias: blueprint[1]! }));
    const lookup = /^\/v1\/setup-operations\/(settings|routine|pairing)\/([^/]+)\/([^/]+)$/.exec(path);
    if (lookup) {
      const kind = lookup[1] as SetupKind, scope = lookup[2]!, requestId = lookup[3]!;
      if (!UUID.test(requestId) || (kind === "routine" ? !UUID.test(scope) : scope !== "installation")) return yield* Effect.fail(new HttpFailure(400,"invalid_input","Invalid setup recovery locator."));
      return yield* io(() => setupLookup(domain,principal,kind,scope.toLowerCase(),requestId.toLowerCase()));
    }
    if (path === "/v1/routines" || path.startsWith("/v1/routines/")) return yield* io(async signal => {
      let botId: string, selected: string | undefined;
      if (path === "/v1/routines") {
        if ([...url.searchParams.keys()].some(k => k !== "botRef") || url.searchParams.getAll("botRef").length !== 1) throw new HttpFailure(400,"invalid_input","Routine lists require one explicit Bot reference.");
        botId = botIdFromRef(url.searchParams.get("botRef")!,domain.installationId);
      } else { const target = routineIdentity(decodeURIComponent(path.slice("/v1/routines/".length)),domain.installationId); botId = target.botId; selected = target.routineId; }
      const snapshot = await native(domain,signal).list(botId), botRef = scopedBot(domain,botId);
      const routines = snapshot.catalog.routines.filter(r => !selected || r.id === selected).map(r => ({ ...r, botRef, routineRef: routineReference(domain.installationId,botId,r.id) } satisfies PublicRoutine));
      if (selected && !routines.length) return no("not_found","The Routine is absent from the returned native window.");
      return { botRef, generation: snapshot.generation, routines, coverage: { ...snapshot.catalog.coverage, limit: 100 } } satisfies RoutineList;
    }).pipe(Effect.timeout("20 seconds"));
    return yield* Effect.fail(new HttpFailure(404,"not_found","The setup endpoint was not found."));
  });
}
