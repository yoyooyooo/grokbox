import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { BoxRuntimeError } from "@grokbox/runtime-kernel/contract";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import {
  HOST_BUNDLE_KEEP,
  observeHostBundles,
  readHostBundleHead,
} from "../../io/provenance.node.ts";
import { hostBundlesDir } from "../../io/paths.ts";

export type RetentionPlan = {
  schemaVersion: 1;
  planDigest: string;
  keep: typeof HOST_BUNDLE_KEEP;
  head: string | null;
  protectedShas: string[];
  remove: string[];
  retentionPressure: boolean;
};

export type TrashAdapter = {
  move(absolutePath: string): Promise<"moved" | "unavailable">;
};

export const unavailableTrash: TrashAdapter = {
  async move() {
    return "unavailable";
  },
};

function invalid(message: string): never {
  throw new BoxRuntimeError("invalid_usage", message);
}

function digestOf(plan: Omit<RetentionPlan, "planDigest">): string {
  return sha256Text(JSON.stringify({
    schemaVersion: plan.schemaVersion,
    keep: plan.keep,
    head: plan.head,
    protectedShas: [...plan.protectedShas].sort(),
    remove: [...plan.remove].sort(),
    retentionPressure: plan.retentionPressure,
  }));
}

export async function buildRetentionPlan(root: string, liveSha: string, extraProtected: readonly string[] = []): Promise<RetentionPlan> {
  const observed = await observeHostBundles(root);
  const head = await readHostBundleHead(root);
  const rows = observed.generations
    .map((row) => ({
      sha: row.sourceSha,
      at: row.metadata?.observedAt ?? "",
      matched: Boolean(row.metadata?.matchedProfileId),
    }))
    .sort((a, b) => a.at.localeCompare(b.at) || a.sha.localeCompare(b.sha));
  const latestMatched = [...rows].reverse().find((row) => row.matched)?.sha ?? null;
  const protectedShas = [...new Set([liveSha, head, latestMatched, ...extraProtected].filter((value): value is string => Boolean(value)))];
  const unprotected = rows.filter((row) => !protectedShas.includes(row.sha));
  const overflow = Math.max(0, rows.length - HOST_BUNDLE_KEEP);
  const remove = overflow > 0 ? unprotected.slice(0, overflow).map((row) => row.sha) : [];
  const draft: Omit<RetentionPlan, "planDigest"> = {
    schemaVersion: 1,
    keep: HOST_BUNDLE_KEEP,
    head,
    protectedShas,
    remove,
    retentionPressure: rows.length > HOST_BUNDLE_KEEP && remove.length === 0,
  };
  return { ...draft, planDigest: digestOf(draft) };
}

export async function readRetentionPlanFile(path: string): Promise<RetentionPlan> {
  if (!isAbsolute(path)) invalid("--plan must be an absolute path.");
  const parsed = JSON.parse(await readFile(resolve(path), "utf8")) as RetentionPlan;
  if (!parsed || parsed.schemaVersion !== 1 || typeof parsed.planDigest !== "string") invalid("Invalid retention plan.");
  const expected = digestOf({
    schemaVersion: 1,
    keep: parsed.keep,
    head: parsed.head,
    protectedShas: parsed.protectedShas,
    remove: parsed.remove,
    retentionPressure: parsed.retentionPressure,
  });
  if (expected !== parsed.planDigest) invalid("plan_stale");
  return parsed;
}

export async function applyRetentionPlan(input: {
  root: string;
  plan: RetentionPlan;
  confirm: boolean;
  liveSha: string;
  trash?: TrashAdapter;
}): Promise<{ moved: string[]; retained: string[]; failed: string[]; retentionPressure: boolean }> {
  if (input.confirm !== true) invalid("runtime profile prune requires --confirm.");
  const selfDigest = digestOf({
    schemaVersion: 1,
    keep: input.plan.keep,
    head: input.plan.head,
    protectedShas: input.plan.protectedShas,
    remove: input.plan.remove,
    retentionPressure: input.plan.retentionPressure,
  });
  if (selfDigest !== input.plan.planDigest) invalid("plan_stale");
  const current = await buildRetentionPlan(input.root, input.liveSha);
  if (current.planDigest !== input.plan.planDigest) invalid("plan_stale");
  const trash = input.trash ?? unavailableTrash;
  const moved: string[] = [];
  const failed: string[] = [];
  const base = join(hostBundlesDir(input.root), "generations");
  for (const sha of input.plan.remove) {
    const target = join(base, sha);
    const outcome = await trash.move(target);
    if (outcome === "unavailable") {
      failed.push(sha);
      break;
    }
    moved.push(sha);
  }
  const after = await buildRetentionPlan(input.root, input.liveSha);
  return {
    moved,
    retained: after.protectedShas,
    failed,
    retentionPressure: after.retentionPressure || failed.length > 0 && input.plan.remove.length > 0,
  };
}
