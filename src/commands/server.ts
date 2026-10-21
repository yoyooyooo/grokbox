import type { CliDeps } from "../deps.ts";
import { CliError, usage } from "../errors.ts";
import { formatTable, writeSuccess } from "../output.ts";
import { ioFromOpts } from "../opts.ts";
import { resolveSecretRef } from "../config/secret.ts";
import {
  DEFAULT_SERVER_BACKEND_URL,
  listServerAgents,
  listServerRoutines,
  mintWebhookKey,
  probeWebhookKey,
  webhookUrlFor,
  type ServerRoutine,
} from "../server-routines.ts";

/**
 * `grokbox server …` reads the account-level Grok Bot Server directly.
 *
 * This is the fallback for Temporal Bots whose box Host does not carry the Routine
 * bridge: the Gateway sees an empty local automation store, while the Server of record
 * still holds the Routines and the only webhook-key mint. It needs its own Profile
 * credential (`server.access_token_ref`) and never borrows Gateway or daemon authority.
 */

export type ServerOptions = {
  json?: boolean;
  table?: boolean;
  timeoutMs?: string;
  agent?: string;
  routine?: string;
  mint?: boolean;
  verify?: boolean;
  revealKey?: boolean;
};

type ServerContext = {
  backendUrl: string;
  token: string;
  timeoutMs: number;
};

async function serverContext(deps: CliDeps, timeoutMs: number): Promise<ServerContext> {
  if (!deps.serverAccessTokenRef) {
    throw new CliError(
      "credential_unavailable",
      "The selected Profile does not declare a Server credential (server.access_token_ref).",
    );
  }
  const token = await resolveSecretRef(deps, deps.serverAccessTokenRef);
  return {
    backendUrl: deps.serverBackendUrl ?? DEFAULT_SERVER_BACKEND_URL,
    token,
    timeoutMs,
  };
}

function routineTable(routines: ServerRoutine[]): string {
  return formatTable(routines.map((routine) => ({
    serverId: routine.serverId,
    localId: routine.localId,
    name: routine.name,
    enabled: String(routine.isEnabled),
    trigger: routine.triggerType,
    webhookUrl: routine.webhookUrl ?? "",
  })));
}

export async function runServerAgents(
  deps: CliDeps,
  raw: ServerOptions,
): Promise<void> {
  const io = ioFromOpts(raw);
  const context = await serverContext(deps, io.timeoutMs);
  const agents = await listServerAgents(deps, context);
  if (io.table) {
    deps.stdout.write(formatTable(agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      harness: agent.harness ?? "",
    }))));
    return;
  }
  writeSuccess(deps.stdout, { count: agents.length, agents });
}

export async function runServerRoutines(
  deps: CliDeps,
  raw: ServerOptions,
): Promise<void> {
  const io = ioFromOpts(raw);
  const agentTarget = (raw.agent ?? "").trim();
  if (agentTarget.length === 0) throw usage("--agent is required.");
  const context = await serverContext(deps, io.timeoutMs);
  const agent = await resolveServerAgent(deps, context, agentTarget);
  const routines = await listServerRoutines(deps, { ...context, agentId: agent.id });
  const selected = raw.routine === undefined
    ? routines
    : routines.filter((routine) =>
      routine.serverId === raw.routine ||
      routine.localId === raw.routine ||
      routine.name === raw.routine);
  if (raw.routine !== undefined && selected.length === 0) {
    throw new CliError("target_not_found", "No Server Routine matched that id or name.", {
      failureCode: "routine_not_found",
    });
  }
  if (io.table) {
    deps.stdout.write(routineTable(selected));
    return;
  }
  writeSuccess(deps.stdout, {
    schemaVersion: 1,
    agent: { id: agent.id, name: agent.name, harness: agent.harness },
    count: selected.length,
    routines: selected,
  });
}

async function resolveServerAgent(
  deps: CliDeps,
  context: ServerContext,
  target: string,
): Promise<{ id: string; name: string; harness: string | null }> {
  const agents = await listServerAgents(deps, context);
  const exact = agents.find((agent) => agent.id === target);
  if (exact) return exact;
  const normalized = target.toLocaleLowerCase();
  const named = agents.filter((agent) => agent.name.toLocaleLowerCase() === normalized);
  if (named.length > 1) {
    throw new CliError("target_ambiguous", "Server agent name matched more than one Bot.");
  }
  const hit = named[0];
  if (hit) return hit;
  throw new CliError("target_not_found", "No Server agent matched that ID or name.");
}

export async function runServerWebhookCredential(
  deps: CliDeps,
  raw: ServerOptions,
): Promise<void> {
  const io = ioFromOpts(raw);
  const agentTarget = (raw.agent ?? "").trim();
  const routineTarget = (raw.routine ?? "").trim();
  if (agentTarget.length === 0) throw usage("--agent is required.");
  if (routineTarget.length === 0) throw usage("--routine is required.");
  const context = await serverContext(deps, io.timeoutMs);
  const agent = await resolveServerAgent(deps, context, agentTarget);
  const routines = await listServerRoutines(deps, { ...context, agentId: agent.id });
  const routine = routines.find((candidate) =>
    candidate.serverId === routineTarget ||
    candidate.localId === routineTarget ||
    candidate.name === routineTarget);
  if (!routine) {
    throw new CliError("target_not_found", "No Server Routine matched that id or name.", {
      failureCode: "routine_not_found",
    });
  }
  if (routine.triggerType !== "webhook") {
    throw new CliError("capability_unavailable", "Routine is not webhook-triggered.");
  }
  const key = await mintWebhookKey(deps, { ...context, serverId: routine.serverId });
  const live = raw.verify === true
    ? await probeWebhookKey(deps, { ...context, key })
    : undefined;
  const reveal = raw.revealKey === true;
  writeSuccess(deps.stdout, {
    schemaVersion: 1,
    agentId: agent.id,
    routineId: routine.localId,
    serverId: routine.serverId,
    url: routine.webhookUrl ?? webhookUrlFor(context.backendUrl, routine.serverId),
    keyPresent: true,
    keyIncluded: reveal,
    ...(live === undefined ? {} : { keyLive: live }),
    ...(reveal ? { key } : {}),
  });
}

