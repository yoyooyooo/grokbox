import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { pbkdf2 } from "node:crypto";
import { join } from "node:path";
import { writeAttestation } from "../../src/internal/io/authority.node.ts";
import { writeAdoptOpState } from "../../src/internal/process/transient-adopt.ts";
const results: string[] = [];
for (const kind of ["attestation", "journal"] as const) {
  const root = await mkdtemp(join(process.argv[2]!, `${kind}-`)); await mkdir(join(root, "state"));
  const path = kind === "attestation" ? join(root, "attestation.json") : join(root, "state", "adopt-op.json");
  const prior = '{"operationId":"prior"}\n'; await writeFile(path, prior);
  const ownership = new AbortController(); let work: Promise<void> | undefined, atExpiry = "", firstGuardPassed = false, completedWhileOwned = false, rejected = false;
  const guard = () => {
    if (ownership.signal.aborted) throw Error("fixture ownership expired");
    if (!work) {
      firstGuardPassed = true;
      work = new Promise<void>((resolve, reject) => pbkdf2("public-fixture", "public-fixture", 500000, 32, "sha256", error => error ? reject(error) : resolve()));
      setTimeout(() => { ownership.abort(); atExpiry = readFileSync(path, "utf8"); }, 5);
    }
  };
  try {
    if (kind === "attestation") await writeAttestation(root, { operationId: "new" } as never, guard);
    else await writeAdoptOpState(root, { operationId: "new", launchMode: "transient-adopt", phase: "commit-attestation", tempSupervisor: null, adoptingSupervisor: null, host: null }, guard);
    completedWhileOwned = !ownership.signal.aborted;
  } catch { rejected = true; }
  await work;
  assert(firstGuardPassed); assert(ownership.signal.aborted);
  if (kind === "attestation") {
    assert(completedWhileOwned); assert(!rejected);
    assert.equal(JSON.parse(atExpiry).operationId, "new", "publication must not wait behind libuv work past expiry");
  } else {
    assert(rejected); assert.equal(atExpiry, prior);
    assert.equal(readFileSync(path, "utf8"), prior, "canonical journal cannot publish after expiry during staging");
  }
  results.push(kind);
}
console.log(JSON.stringify({ cases: results, cryptoJoined: true, noPublicationQueuedPastExpiry: true }));
