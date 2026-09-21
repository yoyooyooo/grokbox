import type { CliDeps } from "../deps.ts";
import { CliError } from "../errors.ts";
import { GatewayClient } from "../gateway.ts";
import { writeSuccess } from "../output.ts";
import { writeGlobalConfig, writeProfileFile, type ProfileFile } from "../config/profile.ts";

export type InitOptions = { json?: boolean; local?: boolean };

/** Connection initialization is Box-local. Operator-managed remote endpoints
 * use profile add/use; init never discovers peers or installs network services. */
export async function runInit(deps: CliDeps, nameArg: string | undefined, _raw: InitOptions): Promise<void> {
  try { await deps.readFile(deps.discoveryPath); }
  catch {
    throw new CliError("discovery_unavailable", "Local Gateway discovery is unavailable. Run init inside the Box, or configure an operator-managed endpoint with grokbox profile add <name> --transport daemon --server-url <https-url> --daemon-token-ref <reference> and select it with profile use.");
  }
  const name = nameArg ?? "default";
  // Establish the actual connection before publishing a profile selection.
  const { discovery, health } = await new GatewayClient(deps).health(10_000);
  const profile: ProfileFile = { version: 1, transport: "auto" };
  if (deps.discoveryPath !== "/home/box/sand-data/gateway.json") profile.gateway_discovery = deps.discoveryPath;
  if (name !== "default" || profile.gateway_discovery !== undefined) await writeProfileFile(deps.configDir, name, profile);
  await writeGlobalConfig(deps.configDir, { version: 1, current_profile: name });
  writeSuccess(deps.stdout, { profile: name, selected: true, target: "local",
    doctor: { ok: health.ok === true, gateway: { pid: discovery.pid, startedAt: discovery.startedAt } } });
}
