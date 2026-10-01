import type { CliDeps } from "../deps.ts";
import { CliError, usage } from "../errors.ts";
import { GatewayClient, gatewayMeta, type GatewayMeta } from "../gateway.ts";
import { formatTable, writeSuccess } from "../output.ts";
import { ioFromOpts, readPrompt } from "../opts.ts";
import {
  nativeRoutineCreateSpec,
  nativeRoutineUpdateSpec,
  projectNativeRoutines,
  routineAgentId,
  routineDefinition,
  routineDefinitionDigest,
  routineId,
  routineOperationId,
  routineRevision,
  RoutineError,
  type RoutineCatalog,
  type RoutineDefinition,
  type RoutineSnapshot,
  type RoutineView,
} from "../routines.ts";
import { asString } from "../util.ts";
import { findRosterRow } from "./roster.ts";

export type RoutineAction =
  | "list"
  | "show"
  | "create"
  | "update"
  | "enable"
  | "disable"
  | "delete";

export type RoutineOptions = {
  json?: boolean;
  table?: boolean;
  timeoutMs?: string;
  name?: string;
  text?: string;
  webhook?: boolean;
  cron?: string;
  expectRevision?: string;
  confirm?: boolean;
  operationId?: string;
};

type Snapshot = RoutineSnapshot & { discovery: GatewayMeta };

type RoutineReceipt = {
  schemaVersion: 1;
  action: Exclude<RoutineAction, "list" | "show">;
  agentId: string;
  routineId: string | null;
  operationId: string;
  state:
    | "disabled_definition_observed"
    | "definition_observed"
    | "unchanged"
    | "requested_state_observed"
    | "absent_in_returned_window";
  beforeRevision: string | null;
  afterRevision: string | null;
  nativeCompareAndSwap: false;
  nativeIdempotency: false;
  automaticRetry: false;
  inFlightRunsCancelled: false;
  webhookInvoked: false;
  effectProof: "preflight_and_readback_only";
};

function routineCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  if (!(error instanceof RoutineError)) {
    return new CliError("gateway_internal", "Routine operation failed.");
  }
  switch (error.reason) {
    case "invalid_input":
      return usage("Routine input is invalid.");
    case "confirmation_required":
      return usage("Routine mutation requires --confirm.");
    case "not_found_in_window":
      return new CliError("target_not_found", "Routine was not found in the returned native window.");
    case "revision_conflict":
      return new CliError("gateway_conflict", "Routine revision changed; read it again before writing.");
    case "unsupported_trigger":
      return new CliError("capability_unavailable", "Routine uses a native shape that grokbox will not mutate.");
    case "unsupported_shape":
      return new CliError("capability_unavailable", "Gateway returned an unsupported Routine shape.");
  }
}

function generation(meta: GatewayMeta): string {
  return `${meta.pid}:${meta.startedAt}`;
}

function sameGeneration(a: GatewayMeta, b: GatewayMeta): boolean {
  return generation(a) === generation(b);
}

function operationId(raw: RoutineOptions, deps: CliDeps): string {
  try {
    return routineOperationId(raw.operationId ?? deps.randomUUID());
  } catch (error) {
    throw routineCliError(error);
  }
}

function expectedRevision(raw: RoutineOptions): string {
  try {
    return routineRevision(raw.expectRevision);
  } catch (error) {
    throw routineCliError(error);
  }
}

function requireConfirmed(raw: RoutineOptions): void {
  if (raw.confirm !== true) throw routineCliError(new RoutineError("confirmation_required"));
}

async function resolveAgent(
  client: GatewayClient,
  target: string,
  timeoutMs: number,
): Promise<{ id: string; discovery: GatewayMeta }> {
  const roster = await client.listAgents(timeoutMs);
  const row = findRosterRow(roster.agents, target, ["agent"]);
  try {
    return { id: routineAgentId(asString(row.id)), discovery: gatewayMeta(roster.discovery) };
  } catch {
    throw new CliError(
      "capability_unavailable",
      "Selected agent does not expose the stable native UUID required for Routine management.",
    );
  }
}

async function readSnapshot(
  client: GatewayClient,
  agentId: string,
  timeoutMs: number,
): Promise<Snapshot> {
  const response = await client.getAgentAutomations(agentId, timeoutMs);
  try {
    return {
      ...projectNativeRoutines(agentId, response.result),
      discovery: gatewayMeta(response.discovery),
    };
  } catch (error) {
    throw routineCliError(error);
  }
}

function findRoutine(snapshot: RoutineSnapshot, id: string): RoutineView {
  let rid: string;
  try {
    rid = routineId(id);
  } catch (error) {
    throw routineCliError(error);
  }
  const row = snapshot.catalog.routines.find((routine) => routine.id === rid);
  if (!row) throw routineCliError(new RoutineError("not_found_in_window"));
  return row;
}

function mutableRoutine(snapshot: RoutineSnapshot, id: string): RoutineView {
  const row = findRoutine(snapshot, id);
  if (!row.mutable) throw routineCliError(new RoutineError("unsupported_trigger"));
  return row;
}

async function definition(raw: RoutineOptions, deps: CliDeps): Promise<RoutineDefinition> {
  const prompt = await readPrompt(raw.text, deps);
  try {
    return routineDefinition({
      name: raw.name,
      prompt,
      webhook: raw.webhook,
      cron: raw.cron,
    });
  } catch (error) {
    throw routineCliError(error);
  }
}

function receipt(input: Omit<RoutineReceipt,
  "schemaVersion" | "nativeCompareAndSwap" | "nativeIdempotency" | "automaticRetry" |
  "inFlightRunsCancelled" | "webhookInvoked" | "effectProof">): RoutineReceipt {
  return {
    schemaVersion: 1,
    ...input,
    nativeCompareAndSwap: false,
    nativeIdempotency: false,
    automaticRetry: false,
    inFlightRunsCancelled: false,
    webhookInvoked: false,
    effectProof: "preflight_and_readback_only",
  };
}

function unknown(operationIdValue: string, message: string): never {
  throw new CliError("operation_outcome_unknown", message, {
    context: { operationId: operationIdValue, phase: "native-routine" },
  });
}

function writeResult(
  deps: CliDeps,
  data: { receipt: RoutineReceipt; routine?: RoutineView },
  discovery: GatewayMeta,
): void {
  writeSuccess(deps.stdout, data, discovery);
}

function listTable(catalog: RoutineCatalog): string {
  return formatTable(catalog.routines.map((routine) => ({
    id: routine.id,
    name: routine.name,
    enabled: String(routine.enabled),
    trigger: routine.trigger.type === "cron" ? `cron:${routine.trigger.schedule}` : routine.trigger.type,
    nextRunAtMs: routine.nextRunAtMs === null ? "" : String(routine.nextRunAtMs),
  })));
}

async function listOrShow(
  deps: CliDeps,
  client: GatewayClient,
  action: "list" | "show",
  agentTarget: string,
  routineTarget: string | undefined,
  raw: RoutineOptions,
): Promise<void> {
  const io = ioFromOpts(raw);
  const agent = await resolveAgent(client, agentTarget, io.timeoutMs);
  const snapshot = await readSnapshot(client, agent.id, io.timeoutMs);
  if (action === "list") {
    if (io.table) {
      deps.stdout.write(listTable(snapshot.catalog));
      return;
    }
    writeSuccess(deps.stdout, snapshot.catalog, snapshot.discovery);
    return;
  }
  const routine = findRoutine(snapshot, routineTarget ?? "");
  writeSuccess(
    deps.stdout,
    { schemaVersion: 1, agentId: agent.id, routine, coverage: snapshot.catalog.coverage },
    snapshot.discovery,
  );
}

async function createRoutine(
  deps: CliDeps,
  client: GatewayClient,
  agentTarget: string,
  raw: RoutineOptions,
): Promise<void> {
  requireConfirmed(raw);
  const io = ioFromOpts(raw);
  const op = operationId(raw, deps);
  const desired = await definition(raw, deps);
  const agent = await resolveAgent(client, agentTarget, io.timeoutMs);
  const before = await readSnapshot(client, agent.id, io.timeoutMs);
  if (before.catalog.coverage.atLimit) {
    throw new CliError(
      "capability_unavailable",
      "Routine window is at the native limit; create cannot be reconciled safely.",
    );
  }

  const expectedDigest = routineDefinitionDigest(desired, false);
  const beforeIds = new Set(before.catalog.routines.map((routine) => routine.id));
  let write;
  try {
    write = await client.createAgentAutomation(
      { id: agent.id, spec: nativeRoutineCreateSpec(desired) },
      io.timeoutMs,
      op,
      before.discovery,
    );
  } catch (error) {
    throw routineCliError(error);
  }
  if (!sameGeneration(before.discovery, gatewayMeta(write.discovery))) {
    return unknown(op, "Gateway generation changed during Routine create; inspect the Routine list before any retry.");
  }
  const after = await readSnapshot(client, agent.id, io.timeoutMs);
  if (!sameGeneration(before.discovery, after.discovery)) {
    return unknown(op, "Gateway generation changed after Routine create; inspect the Routine list before any retry.");
  }
  const candidates = after.catalog.routines.filter((routine) =>
    !beforeIds.has(routine.id) &&
    routine.enabled === false &&
    after.definitionDigests.get(routine.id) === expectedDigest);
  if (candidates.length !== 1) {
    return unknown(op, "Routine create returned but the new native definition could not be uniquely reconciled.");
  }
  const routine = candidates[0]!;
  writeResult(deps, {
    receipt: receipt({
      action: "create",
      agentId: agent.id,
      routineId: routine.id,
      operationId: op,
      state: "disabled_definition_observed",
      beforeRevision: null,
      afterRevision: routine.revision,
    }),
    routine,
  }, after.discovery);
}

async function updateRoutine(
  deps: CliDeps,
  client: GatewayClient,
  agentTarget: string,
  routineTarget: string,
  raw: RoutineOptions,
): Promise<void> {
  requireConfirmed(raw);
  const io = ioFromOpts(raw);
  const op = operationId(raw, deps);
  const expected = expectedRevision(raw);
  const desired = await definition(raw, deps);
  const agent = await resolveAgent(client, agentTarget, io.timeoutMs);
  const before = await readSnapshot(client, agent.id, io.timeoutMs);
  const prior = mutableRoutine(before, routineTarget);
  if (prior.revision !== expected) throw routineCliError(new RoutineError("revision_conflict"));
  const desiredDigest = routineDefinitionDigest(desired, prior.enabled);
  if (before.definitionDigests.get(prior.id) === desiredDigest) {
    writeResult(deps, {
      receipt: receipt({
        action: "update",
        agentId: agent.id,
        routineId: prior.id,
        operationId: op,
        state: "unchanged",
        beforeRevision: prior.revision,
        afterRevision: prior.revision,
      }),
      routine: prior,
    }, before.discovery);
    return;
  }

  let write;
  try {
    write = await client.updateAgentAutomation(
      { id: agent.id, automationId: prior.id, spec: nativeRoutineUpdateSpec(desired) },
      io.timeoutMs,
      op,
      before.discovery,
    );
  } catch (error) {
    throw routineCliError(error);
  }
  if (!sameGeneration(before.discovery, gatewayMeta(write.discovery))) {
    return unknown(op, "Gateway generation changed during Routine update; inspect the Routine before any retry.");
  }
  const after = await readSnapshot(client, agent.id, io.timeoutMs);
  if (!sameGeneration(before.discovery, after.discovery)) {
    return unknown(op, "Gateway generation changed after Routine update; inspect the Routine before any retry.");
  }
  const current = findRoutine(after, prior.id);
  if (
    current.enabled !== prior.enabled ||
    after.definitionDigests.get(prior.id) !== desiredDigest
  ) {
    return unknown(op, "Routine update returned but the requested native definition was not observed.");
  }
  writeResult(deps, {
    receipt: receipt({
      action: "update",
      agentId: agent.id,
      routineId: prior.id,
      operationId: op,
      state: "definition_observed",
      beforeRevision: prior.revision,
      afterRevision: current.revision,
    }),
    routine: current,
  }, after.discovery);
}

async function setRoutineEnabled(
  deps: CliDeps,
  client: GatewayClient,
  agentTarget: string,
  routineTarget: string,
  action: "enable" | "disable",
  raw: RoutineOptions,
): Promise<void> {
  requireConfirmed(raw);
  const io = ioFromOpts(raw);
  const op = operationId(raw, deps);
  const expected = expectedRevision(raw);
  const agent = await resolveAgent(client, agentTarget, io.timeoutMs);
  const before = await readSnapshot(client, agent.id, io.timeoutMs);
  const prior = mutableRoutine(before, routineTarget);
  if (prior.revision !== expected) throw routineCliError(new RoutineError("revision_conflict"));
  const enabled = action === "enable";
  if (prior.enabled === enabled) {
    writeResult(deps, {
      receipt: receipt({
        action,
        agentId: agent.id,
        routineId: prior.id,
        operationId: op,
        state: "unchanged",
        beforeRevision: prior.revision,
        afterRevision: prior.revision,
      }),
      routine: prior,
    }, before.discovery);
    return;
  }

  let write;
  try {
    write = await client.setAgentAutomationEnabled(
      { id: agent.id, automationId: prior.id, isEnabled: enabled },
      io.timeoutMs,
      op,
      before.discovery,
    );
  } catch (error) {
    throw routineCliError(error);
  }
  if (!sameGeneration(before.discovery, gatewayMeta(write.discovery))) {
    return unknown(op, "Gateway generation changed during Routine state change; inspect the Routine before any retry.");
  }
  const after = await readSnapshot(client, agent.id, io.timeoutMs);
  if (!sameGeneration(before.discovery, after.discovery)) {
    return unknown(op, "Gateway generation changed after Routine state change; inspect the Routine before any retry.");
  }
  const current = findRoutine(after, prior.id);
  if (
    current.enabled !== enabled ||
    current.definitionRevision !== prior.definitionRevision
  ) {
    return unknown(op, "Routine state change returned but the requested state was not observed.");
  }
  writeResult(deps, {
    receipt: receipt({
      action,
      agentId: agent.id,
      routineId: prior.id,
      operationId: op,
      state: "requested_state_observed",
      beforeRevision: prior.revision,
      afterRevision: current.revision,
    }),
    routine: current,
  }, after.discovery);
}

async function deleteRoutine(
  deps: CliDeps,
  client: GatewayClient,
  agentTarget: string,
  routineTarget: string,
  raw: RoutineOptions,
): Promise<void> {
  requireConfirmed(raw);
  const io = ioFromOpts(raw);
  const op = operationId(raw, deps);
  const expected = expectedRevision(raw);
  const agent = await resolveAgent(client, agentTarget, io.timeoutMs);
  const before = await readSnapshot(client, agent.id, io.timeoutMs);
  const prior = mutableRoutine(before, routineTarget);
  if (prior.revision !== expected) throw routineCliError(new RoutineError("revision_conflict"));

  let write;
  try {
    write = await client.deleteAgentAutomation(
      { id: agent.id, automationId: prior.id },
      io.timeoutMs,
      op,
      before.discovery,
    );
  } catch (error) {
    throw routineCliError(error);
  }
  if (!sameGeneration(before.discovery, gatewayMeta(write.discovery))) {
    return unknown(op, "Gateway generation changed during Routine delete; inspect the Routine list before any retry.");
  }
  const after = await readSnapshot(client, agent.id, io.timeoutMs);
  if (!sameGeneration(before.discovery, after.discovery)) {
    return unknown(op, "Gateway generation changed after Routine delete; inspect the Routine list before any retry.");
  }
  if (after.catalog.coverage.atLimit || after.catalog.routines.some((routine) => routine.id === prior.id)) {
    return unknown(op, "Routine delete returned but absence could not be proven in the native returned window.");
  }
  writeResult(deps, {
    receipt: receipt({
      action: "delete",
      agentId: agent.id,
      routineId: prior.id,
      operationId: op,
      state: "absent_in_returned_window",
      beforeRevision: prior.revision,
      afterRevision: null,
    }),
  }, after.discovery);
}

export async function runRoutines(
  deps: CliDeps,
  action: RoutineAction,
  agentTarget: string,
  routineTarget: string | undefined,
  raw: RoutineOptions,
): Promise<void> {
  const client = new GatewayClient(deps);
  if (action === "list" || action === "show") {
    await listOrShow(deps, client, action, agentTarget, routineTarget, raw);
    return;
  }
  if (action === "create") {
    await createRoutine(deps, client, agentTarget, raw);
    return;
  }
  if (!routineTarget) throw usage("Routine ID is required.");
  if (action === "update") {
    await updateRoutine(deps, client, agentTarget, routineTarget, raw);
    return;
  }
  if (action === "enable" || action === "disable") {
    await setRoutineEnabled(deps, client, agentTarget, routineTarget, action, raw);
    return;
  }
  await deleteRoutine(deps, client, agentTarget, routineTarget, raw);
}
