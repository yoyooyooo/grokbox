import { lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { boundedText, count, isRecord, observeJson, observeText, type ObservationState } from "./observation.node.ts";
import { join } from "node:path";
import { extractContractSlices, sliceHashes } from "../host/profile.ts";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import { contractsDir } from "./paths.ts";

export type ContractGeneration = {
  sourceSha: string;
  bytes: number;
  observedAt: string;
  sliceHashes: Record<string, string>;
  driftedSlices: string[];
  matchedProfileId?: string;
};

const KEEP = 5;
export const CONTRACT_OBSERVATION_LIMIT = 32;
/** YELLOW: these four first-hit windows are not the 19-slice envelope. `driftedSlices=[]` / patchImpact unchanged is not envelope green. */
export const CONTRACT_SLICE_NAMES = ["create-session", "session-options", "agent-id", "prompt-session"] as const;
const SHA = /^[a-f0-9]{64}$/;

export function parseContractGeneration(value: unknown): ContractGeneration {
  if (!isRecord(value) || typeof value.sourceSha !== "string" || !SHA.test(value.sourceSha) ||
    !count(value.bytes) || !boundedText(value.observedAt) || !Number.isFinite(Date.parse(value.observedAt)) ||
    !isRecord(value.sliceHashes) || !Array.isArray(value.driftedSlices) ||
    value.driftedSlices.length > CONTRACT_SLICE_NAMES.length ||
    !value.driftedSlices.every((key) => (CONTRACT_SLICE_NAMES as readonly unknown[]).includes(key)) ||
    Object.entries(value.sliceHashes).some(([key, hash]) => !(CONTRACT_SLICE_NAMES as readonly string[]).includes(key) || typeof hash !== "string" || !SHA.test(hash)) ||
    (value.matchedProfileId !== undefined && !boundedText(value.matchedProfileId, 128))) throw new Error("invalid contract metadata");
  return {
    sourceSha: value.sourceSha, bytes: value.bytes, observedAt: value.observedAt,
    sliceHashes: { ...value.sliceHashes } as Record<string, string>, driftedSlices: [...value.driftedSlices],
    ...(value.matchedProfileId ? { matchedProfileId: value.matchedProfileId as string } : {}),
  };
}

export type ContractsObservation = {
  state: ObservationState | "partial";
  headState: ObservationState;
  head: string | null;
  generations: Array<{ sourceSha: string; state: ObservationState; metadata: ContractGeneration | null }>;
  truncated: boolean;
  invalidEntries: number;
};

/** Read metadata only from the canonical contracts tree. Never read slices, snapshot or prune. */
export async function observeContracts(root: string): Promise<ContractsObservation> {
  const result: ContractsObservation = { state: "missing", headState: "missing", head: null, generations: [], truncated: false, invalidEntries: 0 };
  const dir = contractsDir(root);
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
    result.truncated = ordered.length > CONTRACT_OBSERVATION_LIMIT;
    for (const sourceSha of ordered.slice(0, CONTRACT_OBSERVATION_LIMIT)) {
      // A HEAD may name a missing directory, but never authorizes a symlink or traversal.
      let state: ObservationState = "missing";
      let metadata: ContractGeneration | null = null;
      if (names.includes(sourceSha)) {
        const meta = await observeJson(join(base, sourceSha, "meta.json"), parseContractGeneration);
        state = meta.state;
        if (meta.state === "present") {
          if (meta.value.sourceSha === sourceSha) metadata = meta.value;
          else state = "invalid";
        }
      } else if (entries.some((entry) => entry.name === sourceSha)) state = "invalid";
      result.generations.push({ sourceSha, state, metadata });
    }
    result.generations.sort((a, b) => (b.metadata?.observedAt ?? "").localeCompare(a.metadata?.observedAt ?? "") || a.sourceSha.localeCompare(b.sourceSha));
    const after = await observeText(join(dir, "HEAD"), 256);
    if (after.state !== head.state || (after.state === "present" && head.state === "present" && after.value !== head.value)) {
      result.head = null;
      result.headState = "invalid";
    }
    result.state = result.headState === "present" && !result.invalidEntries && !result.truncated && result.generations.every((row) => row.state === "present")
      ? "present" : "partial";
    return result;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    return { ...result, state: code === "ENOENT" ? (result.headState === "invalid" ? "invalid" : result.head ? "partial" : "missing") : "unavailable" };
  }
}

async function writeProtected(path: string, body: string): Promise<void> {
  await writeFile(path, body, { mode: 0o600 });
}

export async function snapshotContracts(input: {
  root: string;
  source: string;
  sourceSha: string;
  observedAt: string;
  previous?: ContractGeneration | null;
  matchedProfileId?: string;
}): Promise<ContractGeneration> {
  const dir = contractsDir(input.root);
  const slices = extractContractSlices(input.source);
  const hashes = sliceHashes(slices);
  const driftedSlices: string[] = [];
  if (input.previous) {
    // YELLOW: contract snapshot drift is 4 first-hit windows, not envelopeDrift.
    for (const name of new Set([...Object.keys(hashes), ...Object.keys(input.previous.sliceHashes)])) {
      if (hashes[name] !== input.previous.sliceHashes[name]) driftedSlices.push(name);
    }
  }
  const generation: ContractGeneration = {
    sourceSha: input.sourceSha,
    bytes: Buffer.byteLength(input.source),
    observedAt: input.observedAt,
    sliceHashes: hashes,
    driftedSlices,
    ...(input.matchedProfileId ? { matchedProfileId: input.matchedProfileId } : {}),
  };
  const genDir = join(dir, "generations", input.sourceSha);
  await mkdir(join(genDir, "slices"), { recursive: true, mode: 0o700 });
  await writeProtected(join(genDir, "meta.json"), `${JSON.stringify(generation, null, 2)}\n`);
  for (const [name, text] of Object.entries(slices)) {
    await writeProtected(join(genDir, "slices", name), text);
  }
  await writeProtected(join(dir, "HEAD"), `${input.sourceSha}\n`);
  return generation;
}

export async function readHead(root: string): Promise<string | null> {
  try {
    const text = (await readFile(join(contractsDir(root), "HEAD"), "utf8")).trim();
    return text.length > 0 ? text : null;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

export async function readGeneration(root: string, sha: string): Promise<ContractGeneration | null> {
  try {
    return JSON.parse(await readFile(join(contractsDir(root), "generations", sha, "meta.json"), "utf8")) as ContractGeneration;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

export async function pruneGenerations(input: {
  root: string;
  liveSha: string;
  lastMatchedSha?: string | null;
}): Promise<void> {
  const base = join(contractsDir(input.root), "generations");
  let names: string[] = [];
  try {
    names = await readdir(base);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  const rows: Array<{ sha: string; at: string }> = [];
  for (const sha of names) {
    const meta = await readGeneration(input.root, sha);
    rows.push({ sha, at: meta?.observedAt ?? "" });
  }
  rows.sort((a, b) => a.at.localeCompare(b.at));
  const protectedSha = new Set([input.liveSha, input.lastMatchedSha].filter((value): value is string => Boolean(value)));
  const removable = rows.filter((row) => !protectedSha.has(row.sha));
  while (rows.length > KEEP && removable.length > 0) {
    const drop = removable.shift();
    if (!drop) break;
    await rm(join(base, drop.sha), { recursive: true, force: true });
    const index = rows.findIndex((row) => row.sha === drop.sha);
    if (index >= 0) rows.splice(index, 1);
  }
}

export function hashSource(source: string): string {
  return sha256Text(source);
}
