import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ephemeralRuntimeRoot } from "./ephemeral.ts";
import type { ProcessIdentity } from "./process.ts";

export type CoverageAttestation = {
  mode: "identity";
  coverage: "attested";
  diskSha: string;
  pid: number;
  start: number;
  identity: ProcessIdentity;
  at: string;
  modeld: false;
  windowMs?: number;
};

export function attestationPath(ephemeralRoot = ephemeralRuntimeRoot()): string {
  return join(ephemeralRoot, "attestation.json");
}

export async function readAttestation(root = ephemeralRuntimeRoot()): Promise<CoverageAttestation | null> {
  try {
    return JSON.parse(await readFile(attestationPath(root), "utf8")) as CoverageAttestation;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

export async function writeAttestation(root: string, value: CoverageAttestation): Promise<void> {
  const path = attestationPath(root);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

export async function clearAttestation(root = ephemeralRuntimeRoot()): Promise<void> {
  const path = attestationPath(root);
  await writeFile(path, "", { mode: 0o600 }).catch(() => undefined);
  try {
    const { unlink } = await import("node:fs/promises");
    await unlink(path);
  } catch {
    /* ignore */
  }
}
