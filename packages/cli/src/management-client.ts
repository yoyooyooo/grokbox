import { ManagementClient, ManagementClientError } from "@grokbox/client";
import { openConfigStore, readConfigLayout, readInstallation } from "@grokbox/box-runtime/runtime";
import type { CliDeps } from "./deps.ts";
import { resolveSecretRef } from "./config/secret.ts";

/** A connection is selected for this invocation only. Neither currentProfile,
 * GROKBOX_PROFILE, daemon reachability nor Gateway discovery can redirect it. */
export async function managementClient(deps: CliDeps, options: { connection?: string; timeoutMs?: string }) {
  const layout = await readConfigLayout(deps.configDir);
  const config = (await openConfigStore(layout).read()).document;
  const name = options.connection ?? "default";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) || !Object.hasOwn(config.client.profiles, name)) {
    throw new ManagementClientError("not_found", "The selected connection does not exist.");
  }
  const connection = config.client.profiles[name]!;
  let installationId = connection.installationId, baseUrl = connection.serverUrl;
  if (options.connection === undefined) {
    if (layout.role !== "box") throw new ManagementClientError("unavailable", "No local Box installation is bound to this client; select an explicit connection.");
    const installed = await readInstallation(layout.root);
    if (!installed) throw new ManagementClientError("unavailable", "The local Box installation is unavailable.");
    if (installationId && installationId !== installed.installationId) throw new ManagementClientError("wrong_installation", "The default connection does not match the local installation.");
    installationId = installed.installationId;
    if (!baseUrl && config.daemon?.network) baseUrl = `http://${config.daemon.network.host}:${config.daemon.network.port}`;
    if (baseUrl) {
      const url = new URL(baseUrl);
      if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new ManagementClientError("wrong_installation", "The default connection must remain local; choose a remote connection explicitly.");
    }
  }
  if (!baseUrl || !installationId) throw new ManagementClientError("wrong_installation", "A connection requires a management endpoint and pinned installation ID.");
  if (!connection.daemonTokenRef) throw new ManagementClientError("authentication_required", "The connection has no management credential reference.");
  if (options.timeoutMs !== undefined && !/^[1-9][0-9]{0,5}$/.test(options.timeoutMs)) throw new ManagementClientError("invalid_input", "Invalid request timeout.");
  const credentialRef = connection.daemonTokenRef;
  const client = new ManagementClient({ baseUrl, installationId, fetch: deps.fetch,
    timeoutMs: options.timeoutMs === undefined ? undefined : Number(options.timeoutMs),
    credential: signal => resolveSecretRef(deps, credentialRef, signal),
  });
  return { client, installationId };
}
