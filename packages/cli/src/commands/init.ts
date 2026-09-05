import { bootstrapPeerDaemon, inspectPeerThroughSsh, type BootstrapPeer } from "../bootstrap.ts";
import { retireOwnedFileSecret } from "../config/secret.ts";
import type { CliDeps } from "../deps.ts";
import { CliError, usage } from "../errors.ts";
import { GatewayClient } from "../gateway.ts";
import { writeSuccess } from "../output.ts";
import { asString, isRecord } from "../util.ts";
import {
  listProfileNames,
  profileExists,
  resolveProfile,
  writeGlobalConfig,
  writeProfileFile,
  type ProfileFile,
} from "../config/profile.ts";

export type InitOptions = {
  json?: boolean;
  local?: boolean;
  peer?: string;
  bootstrap?: boolean;
  admitHomeRead?: boolean;
  yes?: boolean;
};

type TailnetNode = { name: string; dnsName: string; ipv4: string | null; self: boolean };

type TailnetProjection = { available: boolean; self: TailnetNode | null; peers: TailnetNode[] };

function projectNode(value: unknown, self: boolean): TailnetNode | null {
  if (!isRecord(value)) return null;
  const dnsName = asString(value.DNSName).replace(/\.$/, "");
  const hostName = asString(value.HostName);
  const tailscaleIPs = Array.isArray(value.TailscaleIPs) ? value.TailscaleIPs : [];
  const ipv4 = tailscaleIPs.find((ip): ip is string => typeof ip === "string" && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) ?? null;
  const name = hostName || dnsName.split(".")[0] || ipv4 || "";
  if (!name && !dnsName && !ipv4) return null;
  return { name, dnsName, ipv4, self };
}

export async function inspectTailnet(deps: CliDeps): Promise<TailnetProjection> {
  const result = await deps.runCommand(["tailscale", "status", "--json"]);
  if (result.code !== 0) return { available: false, self: null, peers: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return { available: false, self: null, peers: [] };
  }
  if (!isRecord(parsed)) return { available: false, self: null, peers: [] };
  const self = projectNode(parsed.Self, true);
  const peers: TailnetNode[] = [];
  if (isRecord(parsed.Peer)) {
    for (const value of Object.values(parsed.Peer)) {
      const peer = projectNode(value, false);
      if (peer) peers.push(peer);
    }
  }
  return { available: self !== null, self, peers };
}

function matchesPeer(node: TailnetNode, query: string): boolean {
  const wanted = query.toLocaleLowerCase().replace(/\.$/, "");
  return [node.name, node.dnsName, node.ipv4]
    .filter((value): value is string => Boolean(value))
    .some((value) => value.toLocaleLowerCase() === wanted);
}

async function selectExistingPeerProfile(
  deps: CliDeps,
  tailnet: TailnetProjection,
): Promise<string | null> {
  const matched: string[] = [];
  for (const name of await listProfileNames(deps.configDir)) {
    if (name === "default") continue;
    const profile = await resolveProfile(deps, name);
    const endpointHost = profile.server_url ? new URL(profile.server_url).hostname : undefined;
    if (
      profile.server_url &&
      profile.daemon_token_ref &&
      tailnet.peers.some((peer) => [profile.ssh_host, endpointHost].filter(Boolean).some((value) => matchesPeer(peer, value!)))
    ) {
      matched.push(name);
    }
  }
  return matched.length === 1 ? matched[0]! : null;
}

export async function runInit(
  deps: CliDeps,
  nameArg: string | undefined,
  raw: InitOptions,
): Promise<void> {
  if (raw.local && raw.peer) throw usage("Choose exactly one of --local or --peer.");
  if (raw.yes && !raw.bootstrap) throw usage("--yes is only valid with --bootstrap.");
  if (raw.admitHomeRead && !raw.bootstrap) {
    throw usage("--admit-home-read is only valid with --bootstrap.");
  }
  if (raw.bootstrap && !deps.stdinIsTTY && !raw.yes) {
    throw usage("Headless bootstrap requires --bootstrap --yes.");
  }
  const name = nameArg ?? "default";
  const tailnet = await inspectTailnet(deps);

  let localAvailable = false;
  try {
    await deps.readFile(deps.discoveryPath);
    localAvailable = true;
  } catch {
    localAvailable = false;
  }

  if (!raw.peer && !raw.local && !localAvailable && tailnet.available) {
    const existing = await selectExistingPeerProfile(deps, tailnet);
    if (existing) {
      await writeGlobalConfig(deps.configDir, { version: 1, current_profile: existing });
      writeSuccess(deps.stdout, { profile: existing, selected: true, existing: true });
      return;
    }
  }

  let selectedPeer: BootstrapPeer | null = null;
  let sshHost: string | null = null;
  if (raw.peer) {
    if (tailnet.available) {
      const candidates = tailnet.peers.filter((peer) => matchesPeer(peer, raw.peer!));
      if (candidates.length === 0) throw new CliError("profile_not_found", "No tailnet peer matched --peer.");
      if (candidates.length > 1) throw new CliError("target_ambiguous", "More than one tailnet peer matched --peer.");
      selectedPeer = candidates[0]!;
      sshHost = raw.peer;
    } else if (raw.bootstrap) {
      selectedPeer = await inspectPeerThroughSsh(deps, raw.peer);
      sshHost = raw.peer;
      if (!selectedPeer) {
        throw new CliError("bootstrap_unavailable", "The peer is unavailable through passwordless BatchMode SSH.");
      }
    } else {
      throw new CliError("tailscale_not_ready", "Tailscale status is unavailable; use --bootstrap with an explicit SSH peer.");
    }
  } else if (!raw.local && !localAvailable && tailnet.available && tailnet.peers.length === 1) {
    selectedPeer = tailnet.peers[0]!;
    sshHost = selectedPeer.dnsName || selectedPeer.name;
  }

  if (selectedPeer && sshHost) {
    let previousDaemonTokenRef: string | undefined;
    if (await profileExists(deps.configDir, name)) {
      const existing = await resolveProfile(deps, name);
      previousDaemonTokenRef = existing.daemon_token_ref;
      if (existing.server_url && !raw.bootstrap) {
        await writeGlobalConfig(deps.configDir, { version: 1, current_profile: name });
        writeSuccess(deps.stdout, { profile: name, selected: true, peer: selectedPeer, existing: true });
        return;
      }
    }

    const bootstrapAllowed = raw.bootstrap || deps.stdinIsTTY;
    if (!bootstrapAllowed) {
      throw new CliError(
        "daemon_endpoint_unavailable",
        `The selected peer has no validated daemon endpoint; run grokbox init ${name} --peer ${sshHost} --bootstrap --yes.`,
      );
    }
    if (deps.stdinIsTTY && !raw.yes) {
      const action = raw.admitHomeRead
        ? "bootstrap or rotate the private daemon and admit read/download access to its home root"
        : "bootstrap or rotate the private grokbox daemon";
      const confirmed = await deps.confirm(`${action} on ${selectedPeer.name}? [y/N] `);
      if (!confirmed) throw usage("Bootstrap was not confirmed.");
    }

    const bootstrapped = await bootstrapPeerDaemon(
      deps,
      name,
      selectedPeer,
      sshHost,
      { admitHomeRead: raw.admitHomeRead === true },
    );
    await writeProfileFile(deps.configDir, name, bootstrapped.profile);
    await writeGlobalConfig(deps.configDir, { version: 1, current_profile: name });
    await retireOwnedFileSecret(
      deps.configDir,
      previousDaemonTokenRef,
      bootstrapped.profile.daemon_token_ref,
    );
    const remoteDeps: CliDeps = {
      ...deps,
      transport: "daemon",
      daemonServerUrl: bootstrapped.serverUrl,
      daemonTokenRef: bootstrapped.profile.daemon_token_ref,
    };
    const { discovery, health } = await new GatewayClient(remoteDeps).health(10_000);
    writeSuccess(deps.stdout, {
      profile: name,
      selected: true,
      target: "peer",
      peer: selectedPeer,
      endpoint: { scheme: discovery.scheme, port: discovery.port },
      bootstrap: {
        completed: true,
        operationId: bootstrapped.operationId,
        daemonPort: bootstrapped.daemonPort,
        serveHttpsPort: bootstrapped.serveHttpsPort,
        credential: "stored-by-reference",
        filesystemPolicy: raw.admitHomeRead ? "home-read-explicitly-admitted" : "existing-policy-preserved",
        audit: {
          action: "daemon-bootstrap",
          outcome: "installed-and-verified",
          credential: "stored-by-reference",
          serve: "exact-private-mapping",
        },
      },
      doctor: { ok: health.ok === true, gateway: { pid: discovery.pid, startedAt: discovery.startedAt } },
    });
    return;
  }

  if (!raw.local && !localAvailable) {
    if (!tailnet.available) {
      throw new CliError("tailscale_not_ready", "No local Gateway was found and Tailscale is not initialized.");
    }
    throw new CliError(
      "target_ambiguous",
      "No trusted Profile uniquely matches this environment; use --local or --peer.",
    );
  }

  if (!localAvailable) throw new CliError("discovery_unavailable", "Local Gateway discovery is unavailable.");
  const profile: ProfileFile = { version: 1, transport: "auto" };
  if (deps.discoveryPath !== "/home/box/sand-data/gateway.json") {
    profile.gateway_discovery = deps.discoveryPath;
  }
  if (name !== "default" || profile.gateway_discovery !== undefined) {
    await writeProfileFile(deps.configDir, name, profile);
  }
  await writeGlobalConfig(deps.configDir, { version: 1, current_profile: name });

  const client = new GatewayClient(deps);
  const { discovery, health } = await client.health(10_000);
  writeSuccess(deps.stdout, {
    profile: name,
    selected: true,
    target: "local",
    tailnet: { available: tailnet.available, self: tailnet.self },
    doctor: {
      ok: health.ok === true,
      gateway: { pid: discovery.pid, startedAt: discovery.startedAt },
    },
  });
}
