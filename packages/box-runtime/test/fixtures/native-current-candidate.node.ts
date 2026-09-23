import assert from "node:assert/strict";
import { readNativeSource } from "../native-host-source.ts";
import { randomUUID } from "node:crypto";
import { Effect, ManagedRuntime } from "effect";
import { sha256Bytes, sha256Text, canonicalJson } from "@grokbox/runtime-kernel/hash";
import { HOST_CHECK_REQUIREMENTS } from "@grokbox/runtime-kernel/host-health";
import { HOST_RECIPE } from "../../src/internal/host/source-recipes.ts";
import { applyPatchProfile, preflightProfileRecipe } from "../../src/internal/host/profile.ts";
import { transformNativeCheckpointWorker } from "../../src/internal/host/native-checkpoint-worker-hook.ts";
import { HostVerifier } from "../../src/internal/ops/host-health/verifier.port.ts";
import { hostVerifierLayer } from "../../src/internal/io/host-verifier/client.node.ts";
import { nativeContinuityPair } from "../native-continuity-pair.ts";

// Isolated driver: read named installed sources, transform only in memory, and
// invoke the production Node/read-only-FD/Rust lane. Never execute Host code.
async function main() {
  assert.equal(process.env.GROKBOX_TEST_NATIVE_CONTINUITY, "1");
  const directory = process.env.GROKBOX_TEST_VERIFIER_DIRECTORY;
  assert.ok(directory);
  const pair = nativeContinuityPair(process.env);
  const source = readNativeSource("source"), worker = readNativeSource("worker");
  assert.equal(sha256Bytes(source), pair.host); assert.equal(sha256Bytes(worker), pair.worker);
  const slices = [...HOST_RECIPE.core, ...HOST_RECIPE.checkpoint, ...HOST_RECIPE.currentState];
  const preflight = preflightProfileRecipe(source.toString("utf8"), slices, HOST_RECIPE.id);
  assert.ok(preflight.ok, "current native full ordered recipe must apply");
  const applied = applyPatchProfile(source.toString("utf8"), preflight.profile);
  assert.ok(applied.ok, "exact reviewed-shape candidate must apply");
  const candidate = Buffer.from(applied.source);
  const workerCandidate = transformNativeCheckpointWorker(worker.toString("utf8"), pair.host);
  const runtime = ManagedRuntime.make(hostVerifierLayer({ directory }));
  const analyze = (bytes: Uint8Array) => runtime.runPromise(Effect.gen(function* () {
    const verifier = yield* HostVerifier;
    return yield* verifier.analyze({ jobId: randomUUID(), attemptId: randomUUID(),
      checks: HOST_CHECK_REQUIREMENTS.map(({ id, revision }) => ({ id, revision })),
      artifacts: [{ role: "source", bytes: source }, { role: "candidate", bytes }, { role: "companion", bytes: worker }] });
  }));
  try {
    const positive = await analyze(candidate);
    assert.ok(positive.artifacts.every(a => a.valid && a.diagnostics === 0));
    assert.ok(positive.checks.every(c => c.state === "passed"));
    const negative = [];
    for (const [name, sliceId, before, after, checker] of [
      ["wrong-input-identity", "agent-id", "invocationId: inferenceRequestId,\n          clientNonce: options2.clientNonce,", "invocationId: inferenceRequestId,\n          clientNonce: undefined,", "session.main-binding"],
      ["managed-retry-reenabled", "managed-turn-retry-gate", "__grokbox_failed(input.error)) return false;", "__grokbox_failed(input.error)) return true;", "retry.turn-guard"],
      ["checkpoint-not-awaited", "compact-register", "await onStateUpdate(ctx, await stateHandler.computeNewStructure(ctx));", "onStateUpdate(ctx, await stateHandler.computeNewStructure(ctx));", "context.checkpoint-await"],
      ["lease-preflight-not-awaited", "compact-register", "await __grokbox_compact_lease.preflight();", "__grokbox_compact_lease.preflight();", "context.lease-finally"],
    ] as const) {
      const target = slices.find(slice => slice.id === sliceId);
      assert.ok(target, `counterexample slice: ${name}`);
      const first = target.replacement.indexOf(before);
      assert.ok(first >= 0 && target.replacement.indexOf(before, first + before.length) < 0, `unique negative mutation: ${name}`);
      const modified = slices.map(slice => slice === target ? { ...slice, replacement: slice.replacement.replace(before, after) } : slice);
      const negativeProfile = preflightProfileRecipe(source.toString("utf8"), modified, HOST_RECIPE.id);
      assert.ok(negativeProfile.ok, `negative ordered recipe: ${name}`);
      const negativeCandidate = applyPatchProfile(source.toString("utf8"), negativeProfile.profile);
      assert.ok(negativeCandidate.ok, `negative recomputed source/candidate hashes: ${name}`);
      const changed: Buffer = Buffer.from(negativeCandidate.source);
      const report = await analyze(changed), artifact = report.artifacts.find(a => a.role === "candidate");
      assert.ok(artifact?.valid && artifact.diagnostics === 0, `counterexample must be legal JS: ${name}`);
      assert.equal(artifact.sha256, sha256Bytes(changed)); assert.notEqual(artifact.sha256, sha256Bytes(candidate));
      const result = report.checks.find(c => c.id === checker);
      assert.equal(result?.state, "violated", `semantic rejection required: ${name}`);
      negative.push({ name, sliceId, checker, state: result.state, code: result.code, candidateSha: artifact.sha256, validJavaScript: true });
    }
    // A replacement while qualification was running cannot inherit this result.
    assert.equal(sha256Bytes(readNativeSource("source")), pair.host);
    assert.equal(sha256Bytes(readNativeSource("worker")), pair.worker);
    console.log(JSON.stringify({ scope: process.env.GROKBOX_TEST_NATIVE_WINDOW ? "fixed-native-snapshot-static" : "current-native-disk-static", sourceSha: pair.host, workerSha: pair.worker,
      recipeId: HOST_RECIPE.id, orderedRecipeSha: sha256Text(canonicalJson(slices)), slices: slices.length,
      candidateSha: sha256Bytes(candidate), candidateBytes: candidate.length,
      workerCandidateSha: sha256Text(workerCandidate), workerCandidateBytes: Buffer.byteLength(workerCandidate),
      profileDigest: sha256Text(canonicalJson(preflight.profile)), verifierBuildId: positive.buildId, schemaDigest: positive.schemaDigest,
      positive: positive.checks.map(({ id, revision, state, code }) => ({ id, revision, state, code })), negative,
      fullHostExecuted: false, loadedProven: false, profilePublished: false, providerRequests: 0, qualified: false }));
  } finally { await runtime.dispose(); }
}
// No private input or error source excerpts in ordinary test output.
main().catch(error => { console.error(JSON.stringify({ ok: false, code: typeof error?.code === "string" ? error.code : "native-candidate-qualification-failed",
  message: error instanceof assert.AssertionError ? error.message : "qualification unavailable" })); process.exitCode = 1; });
