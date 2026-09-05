import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readAttestation } from "./attestation.ts";
import { ephemeralRuntimeRoot } from "./ephemeral.ts";
import { sha256Bytes } from "./hash.ts";
import { attestationAgrees, canonicalOwnershipAgrees } from "./identity-op.ts";
import { LIVE_HOST_BUNDLE } from "./live-slices.ts";
import { linuxProcessPort, procEnvHas, roleOf } from "./live-proc.ts";
import type { DesiredFile, ModelsFile } from "./models.ts";
import { findUniqueOfficialChain, type RoleClassifier } from "./official-chain.ts";
import { CONTROL_PLANE_EVENT_RETENTION, TURN_SEAM_TERMINAL_RETENTION } from "./events.ts";
import { contractsDir, eventsPath } from "./paths.ts";
import { countRoles, type ProcessPort } from "./process.ts";

export type HostOrigin = "official" | "grokbox-attested" | "grokbox-unattested" | "ambiguous";
export type HostReason =
  | null
  | "unmanaged_preload"
  | "stale_attestation"
  | "duplicate_role"
  | "missing_role"
  | "bad_parentage";

export type RuntimeStatus = {
  installation: { durableRoot: string; cliInstallRootUnused: true };
  activation: { desired: DesiredFile["mode"] };
  host: { diskSha: string | null; origin: HostOrigin; reason: HostReason };
  coverage: "none" | "window-open" | "attested";
  census: { wrapper: number | null; supervisor: number | null; host: number | null };
  circuit: "closed" | "open";
  lastHeal: null | { at: string; outcome: string };
  driftedSlices: string[];
  watchdog: { required: boolean; state: "stopped" | "running" | "degraded" };
  modeld: { required: boolean; state: "stopped" | "running" };
  models: { main: string | null; agents: Record<string, string> };
  window: { durationMs: number | null; affectedInvocations: "unknown" };
};

export type LiveStatusPorts = {
  processes?: ProcessPort;
  ephemeralRoot?: string;
  diskSha?: string | null;
  envHas?: (pid: number, key: string) => boolean;
  classify?: RoleClassifier;
};

const GROKBOX_TOUCH_ENV = ["GROKBOX_PRELOAD_MODE", "GROKBOX_OPERATION_ID", "GROKBOX_PRELOAD_MARKER"] as const;

function namedGrokboxTouch(pid: number, envHas: (pid: number, key: string) => boolean): boolean {
  return GROKBOX_TOUCH_ENV.some((key) => envHas(pid, key));
}

function chainReason(code: "duplicate-role" | "missing-role" | "bad-parentage"): HostReason {
  if (code === "duplicate-role") return "duplicate_role";
  if (code === "missing-role") return "missing_role";
  return "bad_parentage";
}

function officialCoverage(mode: DesiredFile["mode"]): "none" | "window-open" {
  return mode === "identity" || mode === "route" ? "window-open" : "none";
}

export async function projectLiveStatus(input: {
  root: string;
  desired: DesiredFile;
  models: ModelsFile;
} & LiveStatusPorts): Promise<RuntimeStatus> {
  const base = projectStatus(input);
  try {
    const port = input.processes ?? linuxProcessPort();
    const classify = input.classify ?? roleOf;
    const envHas = input.envHas ?? ((pid: number, key: string) => procEnvHas(pid, key));
    const sha =
      input.diskSha !== undefined ? input.diskSha : sha256Bytes(await readFile(LIVE_HOST_BUNDLE));
    const identities = port.list();
    const census = countRoles(
      identities.flatMap((ident) => {
        const role = classify(ident);
        return role ? [{ ...ident, role }] : [];
      }),
    );
    const hosts = identities.filter((ident) => classify(ident) === "host");
    const touched = hosts.some((host) => namedGrokboxTouch(host.pid, envHas));
    const liveHost = hosts.length === 1 ? hosts[0]! : null;
    const att = await readAttestation(input.ephemeralRoot ?? ephemeralRuntimeRoot());
    const ownership = canonicalOwnershipAgrees({
      attestation: att,
      liveHost,
      census,
    });
    const agrees = attestationAgrees({
      attestation: att,
      liveHost,
      diskSha: sha,
      census,
    });

    let origin: HostOrigin;
    let reason: HostReason;
    let coverage: RuntimeStatus["coverage"];
    if (touched && ownership) {
      origin = "grokbox-attested";
      if (agrees) {
        reason = null;
        coverage = "attested";
      } else {
        reason = "stale_attestation";
        coverage = officialCoverage(input.desired.mode);
      }
    } else if (touched) {
      origin = "grokbox-unattested";
      reason = att ? "stale_attestation" : "unmanaged_preload";
      coverage = "none";
    } else {
      const unique = findUniqueOfficialChain(port, classify);
      if (unique.ok) {
        origin = "official";
        reason = null;
        coverage = officialCoverage(input.desired.mode);
      } else {
        origin = "ambiguous";
        reason = chainReason(unique.code);
        coverage = "none";
      }
    }

    return {
      ...base,
      host: { diskSha: sha, origin, reason },
      coverage,
      census: { wrapper: census.wrapper, supervisor: census.supervisor, host: census.host },
      watchdog: {
        required: input.desired.mode === "identity" || input.desired.mode === "route",
        state: "stopped",
      },
      modeld: { required: false, state: "stopped" },
      window: {
        durationMs: att?.windowMs ?? null,
        affectedInvocations: "unknown",
      },
    };
  } catch {
    return base;
  }
}

export function projectStatus(input: {
  root: string;
  desired: DesiredFile;
  models: ModelsFile;
}): RuntimeStatus {
  const required = input.desired.mode === "route" || input.desired.mode === "identity";
  return {
    installation: { durableRoot: input.root, cliInstallRootUnused: true },
    activation: { desired: input.desired.mode },
    host: { diskSha: null, origin: "ambiguous", reason: "missing_role" },
    coverage: "none",
    census: { wrapper: null, supervisor: null, host: null },
    circuit: "closed",
    lastHeal: null,
    driftedSlices: [],
    watchdog: { required, state: "stopped" },
    modeld: { required: input.desired.mode === "route", state: "stopped" },
    models: {
      main: input.models.assignments.main,
      agents: input.models.assignments.agents,
    },
    window: { durationMs: null, affectedInvocations: "unknown" },
  };
}

export async function readEvents(
  root: string,
  limit = CONTROL_PLANE_EVENT_RETENTION + TURN_SEAM_TERMINAL_RETENTION,
): Promise<unknown[]> {
  let text: string;
  try {
    text = await readFile(eventsPath(root), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const lines = text.split("\n").filter((line) => line.length > 0);
  const slice = lines.slice(-limit);
  const events: unknown[] = [];
  for (const line of slice) {
    try {
      events.push(JSON.parse(line) as unknown);
    } catch {
      events.push({ invalid: true });
    }
  }
  return events;
}

export async function readContracts(root: string): Promise<{
  head: string | null;
  generations: Array<{ sourceSha: string; driftedSlices: string[] }>;
}> {
  const dir = contractsDir(root);
  let head: string | null = null;
  try {
    head = (await readFile(join(dir, "HEAD"), "utf8")).trim() || null;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  return { head, generations: [] };
}
