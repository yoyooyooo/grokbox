import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { extractContractSlices, sliceHashes } from "./transform.ts";
import { sha256Text } from "./hash.ts";
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
