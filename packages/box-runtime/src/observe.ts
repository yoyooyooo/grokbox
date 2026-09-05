import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { contractsDir, eventsPath } from "./paths.ts";
import type { DesiredFile, ModelsFile } from "./models.ts";

export type RuntimeStatus = {
  installation: { durableRoot: string; cliInstallRootUnused: true };
  activation: { desired: DesiredFile["mode"] };
  host: { diskSha: string | null };
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

export async function projectLiveStatus(input: {
  root: string;
  desired: DesiredFile;
  models: ModelsFile;
}): Promise<RuntimeStatus> {
  const base = projectStatus(input);
  try {
    const { readFile } = await import("node:fs/promises");
    const { sha256Bytes } = await import("./hash.ts");
    const { LIVE_HOST_BUNDLE } = await import("./live-slices.ts");
    const { findRole, linuxProcessPort, roleOf } = await import("./live-proc.ts");
    const { countRoles } = await import("./process.ts");
    const { readAttestation } = await import("./attestation.ts");
    const { attestationAgrees } = await import("./identity-op.ts");
    const sha = sha256Bytes(await readFile(LIVE_HOST_BUNDLE));
    const port = linuxProcessPort();
    const census = countRoles(
      port.list().flatMap((ident) => {
        const role = roleOf(ident);
        return role ? [{ ...ident, role }] : [];
      }),
    );
    const host = findRole(port, "host");
    const att = await readAttestation();
    const attested = attestationAgrees({
      attestation: att,
      liveHost: host,
      diskSha: sha,
      census,
    });
    return {
      ...base,
      host: { diskSha: sha },
      coverage: attested ? "attested" : base.coverage,
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
    host: { diskSha: null },
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

export async function readEvents(root: string, limit = 256): Promise<unknown[]> {
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
