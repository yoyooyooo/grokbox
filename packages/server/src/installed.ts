import { isAbsolute, join, resolve } from "node:path";
import { CAPABILITIES } from "@grokbox/client/contract";
import { validateConfig } from "@grokbox/runtime-kernel/config";
import { createManagementGateway, openMonitorStore, openRuntimeStore, readConfigFile, readInstallation, readStorageConfiguration } from "@grokbox/box-runtime/runtime";
import { HttpFailure } from "./access.ts";
import { startManagementServer } from "./server.ts";

export type InstalledServerOptions = {
  root: string;
  discoveryPath: string;
  host?: "127.0.0.1" | "::1";
  port?: number;
  allowedOrigins?: readonly string[];
};

/** Installation and credential ownership are existing canonical facts. Startup
 * reads them; it does not initialize, mint keys, migrate or adopt the Host. */
export async function startInstalledManagementServer(options: InstalledServerOptions) {
  if (!isAbsolute(options.root) || !isAbsolute(options.discoveryPath)) throw new HttpFailure(400, "invalid_input", "Service roots and native discovery must be explicit absolute paths.");
  const root = resolve(options.root);
  const installation = await readInstallation(root);
  if (!installation?.daemon?.tokenSha256) throw new HttpFailure(503, "unavailable", "A qualified Box installation and management credential verifier are required.");
  const config = validateConfig(await readConfigFile(join(root, "config.json")));
  const port = options.port ?? config.daemon?.network?.port;
  if (port === undefined) throw new HttpFailure(400, "invalid_input", "Configure the management listener or select an explicit port.");
  const native = createManagementGateway({ discoveryPath: options.discoveryPath, configurationRoot: root });
  const observations = openMonitorStore(root);
  // Reads and completed receipt lookup do not consult mutable writer policy.
  // New commits use the canonical storage budget, just like the original writer.
  const incidentStore = { ...observations, manage: async (...args: Parameters<typeof observations.manage>) =>
    openMonitorStore(root, (await readStorageConfiguration(root)).monitor).manage(...args) };
  return startManagementServer({
    installationId: installation.installationId,
    store: openRuntimeStore(root), native, observations: incidentStore, port, host: options.host ?? config.daemon?.network?.host,
    allowedOrigins: options.allowedOrigins,
    readGrants: async () => {
      const current = await readInstallation(root);
      if (current?.installationId !== installation.installationId || !current.daemon?.tokenSha256) throw new HttpFailure(503, "unavailable", "The installed management authority changed or became unavailable.");
      return [{ tokenSha256: current.daemon.tokenSha256, principalId: "installation-owner", capabilities: [...CAPABILITIES] }];
    },
  });
}
