import { ManagementClient, ManagementClientError, UUID } from "@grokbox/client";
import { openConfigStore, readConfigLayout, commitConfigChange } from "@grokbox/box-runtime/runtime";
import { ConfigError, isObject, type ConnectionProfile } from "@grokbox/runtime-kernel/config";
import type { CliDeps } from "../deps.ts";
import { readManagementInput } from "../management-input.ts";
import { managementClient } from "../management-client.ts";
import type { ManagementCommandOptions } from "./management-api.ts";

const invalid = () => new ManagementClientError("invalid_input", "Use an exact connection name, pinned endpoint, credential reference and persisted request identity.");
function nameOf(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value) || ["__proto__", "constructor", "prototype"].includes(value)) throw invalid();
  return value;
}
function view(name: string, profile: ConnectionProfile) {
  return { name, endpoint: profile.serverUrl ? new URL(profile.serverUrl).origin : null,
    installationId: profile.installationId ?? null, credentialConfigured: Boolean(profile.daemonTokenRef),
    recovery: { sshConfigured: Boolean(profile.sshHost), externalBoxConfigured: Boolean(profile.sandbox?.accessTokenRef) } };
}
/** These are initiating-machine preferences, never writes to the selected Box.
 * The canonical config lease/revision/receipt remains the only publisher. */
export async function connectionCommand(deps: CliDeps, command: string, args: Array<string | undefined>, options: ManagementCommandOptions) {
  try { return await executeConnection(deps, command, args, options); }
  catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    throw new ManagementClientError(error.code === "config_idempotency_conflict" ? "idempotency_conflict"
      : error.code === "config_conflict" ? "revision_conflict" : error.code === "config_commit_unknown" ? "operation_unknown" : "invalid_input",
      "The local connection request could not complete; inspect its original receipt before retrying.");
  }
}
async function executeConnection(deps: CliDeps, command: string, args: Array<string | undefined>, options: ManagementCommandOptions) {
  if (options.connection !== undefined) throw invalid();
  const layout = await readConfigLayout(deps.configDir);
  const store = openConfigStore(layout);
  if (command === "connection check") {
    const name = nameOf(args[0]);
    const { client } = await managementClient(deps, { connection: name, timeoutMs: options.timeoutMs });
    return (await client.identity(deps.signal)).data;
  }
  if (command === "connection operation get") {
    if (!UUID.test(args[0] ?? "")) throw invalid();
    const receipt = await store.receipt(`connection:${args[0]!.toLowerCase()}`);
    if (!receipt) throw new ManagementClientError("not_found", "No local connection receipt exists for that request.");
    return { ...receipt, target: "initiating-machine", remoteChanged: false };
  }
  if (command === "connection list" || command === "connection get") {
    const snapshot = await store.read();
    if (command === "connection list") return { connections: Object.entries(snapshot.document.client.profiles).map(([name, profile]) => view(name, profile)),
      revision: snapshot.revision, selection: "per-invocation" };
    const name = nameOf(args[0]);
    const profile = Object.hasOwn(snapshot.document.client.profiles, name) ? snapshot.document.client.profiles[name] : undefined;
    if (!profile) throw new ManagementClientError("not_found", "The connection does not exist.");
    return { connection: view(name, profile), revision: snapshot.revision };
  }
  const name = nameOf(args[0]);
  if (!UUID.test(options.requestId ?? "") || !/^[a-f0-9]{64}$/.test(options.expectRevision ?? "") || options.confirm !== true) throw invalid();
  const common = { operationId: `connection:${options.requestId!.toLowerCase()}`, expectedRevision: options.expectRevision!,
    scope: "client" as const, confirm: true };
  if (command === "connection delete") {
    const receipt = await commitConfigChange(store, { ...common, kind: "connection", name, connection: null });
    return { ...receipt, target: "initiating-machine", remoteChanged: false };
  }
  if (command !== "connection set") throw invalid();
  const input = await readManagementInput(deps, options.input);
  if (!isObject(input) || Object.keys(input).some(key => !["endpoint", "installationId", "credentialRef"].includes(key))
    || typeof input.endpoint !== "string" || typeof input.installationId !== "string" || !UUID.test(input.installationId)
    || typeof input.credentialRef !== "string") throw invalid();
  // Reuse the public client's endpoint rules before publishing a preference.
  new ManagementClient({ baseUrl: input.endpoint, installationId: input.installationId });
  if (name === "default" && !["127.0.0.1", "localhost", "[::1]"].includes(new URL(input.endpoint).hostname)) throw invalid();
  if (name === "default" && layout.installationId && input.installationId.toLowerCase() !== layout.installationId) throw new ManagementClientError("wrong_installation", "The fixed local connection must retain this installation.");
  // Update only management fields. External Box/SSH/Gateway declarations stay
  // with their existing owners; no implicit global selection is introduced.
  const receipt = await commitConfigChange(store, { ...common, kind: "connection", name,
    connection: { endpoint: input.endpoint, installationId: input.installationId.toLowerCase(), credentialRef: input.credentialRef } });
  return { ...receipt, target: "initiating-machine", remoteChanged: false };
}
