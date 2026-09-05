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
