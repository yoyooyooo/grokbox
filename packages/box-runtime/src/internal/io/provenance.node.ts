import { lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CONTRACT_SLICE_NAMES } from "./contracts.ts";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import { boundedText, count, isRecord, observeJson, observeText, type ObservationState } from "./observation.node.ts";
import { hostBundlesDir } from "./paths.ts";
import { extractContractSlices, sliceHashes } from "../host/profile.ts";

export const HOST_BUNDLE_KEEP = 16;
export const HOST_BUNDLE_OBSERVATION_LIMIT = 32;
const SHA = /^[a-f0-9]{64}$/;
const SOURCE_NAME = "source";

export type HostBundleMeta = {
  sourceSha: string;
  bytes: number;
  observedAt: string;
  matchedProfileId?: string;
};

export type HostBundlePatchImpact = {
  slice: (typeof CONTRACT_SLICE_NAMES)[number];
  status: "unchanged" | "drifted" | "missing" | "appeared";
  review: "none" | "re-review";
};

export type HostBundleDiff = {
  previousSha: string;
  previousBytes: number;
  currentBytes: number;
  previousLines: number;
  currentLines: number;
  addedLines: number;
  removedLines: number;
  hunks: number;
  driftedSlices: string[];
  patchImpact: HostBundlePatchImpact[];
};

export type HostBundleRetainResult = {
  sourceSha: string;
  retained: "new" | "existing";
  meta: HostBundleMeta;
  diff: HostBundleDiff | null;
};

export type HostBundlesObservation = {
  state: ObservationState | "partial";
  headState: ObservationState;
  head: string | null;
  generations: Array<{
    sourceSha: string;
    state: ObservationState;
    metadata: HostBundleMeta | null;
    diff: HostBundleDiff | null;
  }>;
  truncated: boolean;
  invalidEntries: number;
};

export function parseHostBundleMeta(value: unknown): HostBundleMeta {
  if (!isRecord(value) || typeof value.sourceSha !== "string" || !SHA.test(value.sourceSha) ||
    !count(value.bytes) || !boundedText(value.observedAt) || !Number.isFinite(Date.parse(value.observedAt)) ||
    (value.matchedProfileId !== undefined && !boundedText(value.matchedProfileId, 128))) {
    throw new Error("invalid host-bundle metadata");
  }
  return {
    sourceSha: value.sourceSha,
    bytes: value.bytes,
    observedAt: value.observedAt,
    ...(value.matchedProfileId ? { matchedProfileId: value.matchedProfileId as string } : {}),
  };
}

export function parseHostBundleDiff(value: unknown): HostBundleDiff {
  if (!isRecord(value) || typeof value.previousSha !== "string" || !SHA.test(value.previousSha) ||
    !count(value.previousBytes) || !count(value.currentBytes) ||
    !count(value.previousLines) || !count(value.currentLines) ||
    !count(value.addedLines) || !count(value.removedLines) || !count(value.hunks) ||
    !Array.isArray(value.driftedSlices) || value.driftedSlices.length > CONTRACT_SLICE_NAMES.length ||
    !value.driftedSlices.every((key) => (CONTRACT_SLICE_NAMES as readonly unknown[]).includes(key)) ||
    !Array.isArray(value.patchImpact) || value.patchImpact.length > CONTRACT_SLICE_NAMES.length) {
    throw new Error("invalid host-bundle diff");
  }
  const patchImpact = value.patchImpact.map((row) => {
    if (!isRecord(row) || !(CONTRACT_SLICE_NAMES as readonly unknown[]).includes(row.slice) ||
      !["unchanged", "drifted", "missing", "appeared"].includes(String(row.status)) ||
      (row.review !== "none" && row.review !== "re-review")) {
      throw new Error("invalid host-bundle diff");
    }
    return {
      slice: row.slice as HostBundlePatchImpact["slice"],
      status: row.status as HostBundlePatchImpact["status"],
      review: row.review as HostBundlePatchImpact["review"],
    };
  });
  return {
    previousSha: value.previousSha,
    previousBytes: value.previousBytes,
    currentBytes: value.currentBytes,
    previousLines: value.previousLines as number,
    currentLines: value.currentLines as number,
    addedLines: value.addedLines as number,
    removedLines: value.removedLines as number,
    hunks: value.hunks as number,
    driftedSlices: [...value.driftedSlices as string[]],
    patchImpact,
  };
}

function generationDir(root: string, sha: string): string {
  return join(hostBundlesDir(root), "generations", sha);
}

function sourcePath(root: string, sha: string): string {
  return join(generationDir(root, sha), SOURCE_NAME);
}

async function isRealDir(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function writeProtected(path: string, body: string | Uint8Array): Promise<void> {
  await writeFile(path, body, { mode: 0o600, flag: "wx" });
}

export function lineDiffStats(previous: string, current: string): Pick<HostBundleDiff,
  "previousLines" | "currentLines" | "addedLines" | "removedLines" | "hunks"> {
  const prev = previous.split("\n");
  const next = current.split("\n");
  let start = 0;
  const min = Math.min(prev.length, next.length);
  while (start < min && prev[start] === next[start]) start += 1;
  let endPrev = prev.length;
  let endNext = next.length;
  while (endPrev > start && endNext > start && prev[endPrev - 1] === next[endNext - 1]) {
    endPrev -= 1;
    endNext -= 1;
  }
  const removedLines = endPrev - start;
  const addedLines = endNext - start;
  return {
    previousLines: prev.length,
    currentLines: next.length,
    addedLines,
    removedLines,
    hunks: removedLines === 0 && addedLines === 0 ? 0 : 1,
  };
}

export function hostBundlePatchImpact(previous: string | null, current: string): HostBundlePatchImpact[] {
  const currentHashes = sliceHashes(extractContractSlices(current));
  const previousHashes = previous ? sliceHashes(extractContractSlices(previous)) : {};
  return CONTRACT_SLICE_NAMES.map((slice) => {
    const hasPrev = Object.hasOwn(previousHashes, slice) && previousHashes[slice]!.length > 0;
    const hasCur = Object.hasOwn(currentHashes, slice) && currentHashes[slice]!.length > 0;
    if (!hasPrev && !hasCur) return { slice, status: "missing" as const, review: "re-review" as const };
    if (!hasPrev && hasCur) return { slice, status: "appeared" as const, review: "re-review" as const };
    if (hasPrev && !hasCur) return { slice, status: "missing" as const, review: "re-review" as const };
    if (previousHashes[slice] !== currentHashes[slice]) return { slice, status: "drifted" as const, review: "re-review" as const };
    return { slice, status: "unchanged" as const, review: "none" as const };
  });
}

export function buildHostBundleDiff(previousSha: string, previous: string, current: string): HostBundleDiff {
  const stats = lineDiffStats(previous, current);
  const impact = hostBundlePatchImpact(previous, current);
  return {
    previousSha,
    previousBytes: Buffer.byteLength(previous),
    currentBytes: Buffer.byteLength(current),
    ...stats,
    driftedSlices: impact.filter((row) => row.status === "drifted" || row.status === "missing" || row.status === "appeared")
      .map((row) => row.slice),
    patchImpact: impact,
  };
}

export async function readHostBundleHead(root: string): Promise<string | null> {
  try {
    const text = (await readFile(join(hostBundlesDir(root), "HEAD"), "utf8")).trim();
    return SHA.test(text) ? text : null;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

export async function readHostBundleMeta(root: string, sha: string): Promise<HostBundleMeta | null> {
  if (!SHA.test(sha)) return null;
  try {
    return parseHostBundleMeta(JSON.parse(await readFile(join(generationDir(root, sha), "meta.json"), "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function readStoredSource(root: string, sha: string): Promise<string | null> {
  if (!SHA.test(sha)) return null;
  try {
    const bytes = await readFile(sourcePath(root, sha));
    if (sha256Text(bytes.toString("utf8")) !== sha) return null;
    return bytes.toString("utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

export async function retainHostBundle(input: {
  root: string;
  source: string;
  sourceSha: string;
  observedAt: string;
  matchedProfileId?: string;
}): Promise<HostBundleRetainResult> {
  if (!SHA.test(input.sourceSha) || sha256Text(input.source) !== input.sourceSha) {
    throw new Error("host-bundle-sha-mismatch");
  }
  const dir = hostBundlesDir(input.root);
  const genDir = generationDir(input.root, input.sourceSha);
  const dest = sourcePath(input.root, input.sourceSha);
  await mkdir(join(dir, "generations"), { recursive: true, mode: 0o700 });
  if (await isRealDir(join(dir, "generations")) === false) throw new Error("invalid host-bundle path");
  const existed = await isRealDir(genDir);
  if (existed) {
    const stored = await readStoredSource(input.root, input.sourceSha);
    if (stored !== null) {
      if (stored !== input.source) throw new Error("host-bundle-bytes-mismatch");
      const meta = await readHostBundleMeta(input.root, input.sourceSha);
      if (!meta || meta.sourceSha !== input.sourceSha) throw new Error("host-bundle-bytes-mismatch");
      await writeFile(join(dir, "HEAD"), `${input.sourceSha}\n`, { mode: 0o600 });
      return { sourceSha: input.sourceSha, retained: "existing", meta, diff: null };
    }
    try {
      await lstat(dest);
      throw new Error("host-bundle-bytes-mismatch");
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    }
  } else if (await lstat(genDir).then(() => true, (error) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  })) throw new Error("invalid host-bundle path");
  await mkdir(genDir, { recursive: true, mode: 0o700 });
  const previousSha = await readHostBundleHead(input.root);
  const previousSource = previousSha && previousSha !== input.sourceSha ? await readStoredSource(input.root, previousSha) : null;
  const meta: HostBundleMeta = {
    sourceSha: input.sourceSha,
    bytes: Buffer.byteLength(input.source),
    observedAt: input.observedAt,
    ...(input.matchedProfileId ? { matchedProfileId: input.matchedProfileId } : {}),
  };
  const diff = previousSha && previousSource !== null && previousSha !== input.sourceSha
    ? buildHostBundleDiff(previousSha, previousSource, input.source)
    : null;
  try {
    await writeProtected(dest, input.source);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
    const stored = await readStoredSource(input.root, input.sourceSha);
    if (stored === null || stored !== input.source) throw new Error("host-bundle-bytes-mismatch");
    const existing = await readHostBundleMeta(input.root, input.sourceSha);
    if (!existing) throw new Error("host-bundle-bytes-mismatch");
    await writeFile(join(dir, "HEAD"), `${input.sourceSha}\n`, { mode: 0o600 });
    return { sourceSha: input.sourceSha, retained: "existing", meta: existing, diff: null };
  }
  await writeProtected(join(genDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  if (diff) await writeProtected(join(genDir, "diff.json"), `${JSON.stringify(diff, null, 2)}\n`);
  await writeFile(join(dir, "HEAD"), `${input.sourceSha}\n`, { mode: 0o600 });
  return { sourceSha: input.sourceSha, retained: "new", meta, diff };
}

export async function observeHostBundles(root: string): Promise<HostBundlesObservation> {
  const result: HostBundlesObservation = {
    state: "missing", headState: "missing", head: null, generations: [], truncated: false, invalidEntries: 0,
  };
  const dir = hostBundlesDir(root);
  try {
    const info = await lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink()) return { ...result, state: "invalid", headState: "invalid" };
    const head = await observeText(join(dir, "HEAD"), 256);
    result.headState = head.state;
    if (head.state === "present") {
      if (!SHA.test(head.value.trim())) result.headState = "invalid";
      else result.head = head.value.trim();
    }
    const base = join(dir, "generations");
    const baseInfo = await lstat(base);
    if (!baseInfo.isDirectory() || baseInfo.isSymbolicLink()) return { ...result, state: "invalid" };
    const entries = await readdir(base, { withFileTypes: true });
    const names = entries.filter((entry) => SHA.test(entry.name) && entry.isDirectory()).map((entry) => entry.name).sort();
    result.invalidEntries = entries.filter((entry) => !entry.name.startsWith(".") && (!SHA.test(entry.name) || !entry.isDirectory())).length;
    const ordered = [...new Set([...(result.head ? [result.head] : []), ...names])];
    result.truncated = ordered.length > HOST_BUNDLE_OBSERVATION_LIMIT;
    for (const sourceSha of ordered.slice(0, HOST_BUNDLE_OBSERVATION_LIMIT)) {
      let state: ObservationState = "missing";
      let metadata: HostBundleMeta | null = null;
      let diff: HostBundleDiff | null = null;
      if (names.includes(sourceSha)) {
        const meta = await observeJson(join(base, sourceSha, "meta.json"), parseHostBundleMeta);
        state = meta.state;
        if (meta.state === "present") {
          if (meta.value.sourceSha === sourceSha) metadata = meta.value;
          else state = "invalid";
        }
        const diffRead = await observeJson(join(base, sourceSha, "diff.json"), parseHostBundleDiff);
        if (diffRead.state === "present") diff = diffRead.value;
        else if (diffRead.state === "invalid") state = "invalid";
      } else if (entries.some((entry) => entry.name === sourceSha)) state = "invalid";
      result.generations.push({ sourceSha, state, metadata, diff });
    }
    result.generations.sort((a, b) => (b.metadata?.observedAt ?? "").localeCompare(a.metadata?.observedAt ?? "") || a.sourceSha.localeCompare(b.sourceSha));
    result.state = result.headState === "present" && !result.invalidEntries && !result.truncated &&
      result.generations.every((row) => row.state === "present")
      ? "present" : result.head || result.generations.length ? "partial" : "missing";
    return result;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    return { ...result, state: code === "ENOENT" ? (result.head ? "partial" : "missing") : "unavailable" };
  }
}

export const readHostBundles = observeHostBundles;

export async function pruneHostBundles(input: {
  root: string;
  liveSha: string;
  lastMatchedSha?: string | null;
}): Promise<void> {
  const base = join(hostBundlesDir(input.root), "generations");
  let names: string[] = [];
  try {
    names = await readdir(base);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  const rows: Array<{ sha: string; at: string; matched: boolean }> = [];
  for (const sha of names) {
    if (!SHA.test(sha)) continue;
    const meta = await readHostBundleMeta(input.root, sha);
    rows.push({ sha, at: meta?.observedAt ?? "", matched: Boolean(meta?.matchedProfileId) });
  }
  rows.sort((a, b) => a.at.localeCompare(b.at) || a.sha.localeCompare(b.sha));
  const latestMatched = [...rows].reverse().find((row) => row.matched)?.sha ?? null;
  const protectedSha = new Set([input.liveSha, input.lastMatchedSha, latestMatched].filter((value): value is string => Boolean(value)));
  const removable = rows.filter((row) => !protectedSha.has(row.sha));
  while (rows.length > HOST_BUNDLE_KEEP && removable.length > 0) {
    const drop = removable.shift();
    if (!drop) break;
    await rm(join(base, drop.sha), { recursive: true, force: true });
    const index = rows.findIndex((row) => row.sha === drop.sha);
    if (index >= 0) rows.splice(index, 1);
  }
}
