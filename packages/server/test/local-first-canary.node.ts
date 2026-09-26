import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runCreationCanary, creationCanaryFiles, creationCanaryCli, checkCanaryArtifact, type CreationCanaryPlan } from "../../../scripts/local-first-canary.mjs";
import { productFixture, productCommand, P_INSTALL, P_OWNER } from "./product-fixture.node.ts";

for (const mode of ["passed", "registration-unknown", "temporal", "cleanup-failed", "response-lost", "stale", "unsupported", "no-authorization"] as const) {
  test(`formal Node CLI creation canary: ${mode}`, { timeout: 35000 }, async () => {
    const f = await productFixture(); f.state.localFirst = true;
    try {
      const original = structuredClone([...f.state.rows.entries()]);
      const models = await f.options.store.loadModels();
      const requestId = randomUUID(), intent = productCommand("create", "bot", { requestId, profile: { name: "Quiet canary", description: "" } });
      const preview = (await f.client().previewProduct(intent)).data;
      const entry = process.env.GROKBOX_TEST_CLI_ENTRY!, artifactSha256 = createHash("sha256").update(await readFile(entry)).digest("hex");
      await checkCanaryArtifact(entry, artifactSha256);
      const plan: CreationCanaryPlan = { version: 1, requestId, cleanupRequestId: randomUUID(), scopeId: preview.scopeId, installationId: P_INSTALL,
        maxAgeMs: 60000, expectedNativeGeneration: preview.sourceGeneration, artifactSha256, authorizationRef: mode === "no-authorization" ? null : "private:synthetic-owned-fixture",
        expectedSource: structuredClone(preview.creationSource!),
        profile: { name: "Quiet canary", description: "" } };
      if (mode === "stale") plan.expectedSource.sourceSha256 = "f".repeat(64);
      if (mode === "unsupported") f.state.creationSupported = false;
      const prevented = ["stale", "unsupported", "no-authorization"].includes(mode);
      f.state.registrationError = mode === "registration-unknown"; f.state.registrationTemporal = mode === "temporal";
      f.state.failCleanup = mode === "cleanup-failed";
      if (mode === "response-lost") f.state.afterWrite = async () => { f.state.failAfterWrite = f.state.writes === 1; };
      const files = await creationCanaryFiles(join(f.root, "canary"));
      const cli = creationCanaryCli(entry, { PATH: process.env.PATH, HOME: f.root, GROKBOX_CONFIG_DIR: f.root,
        GROKBOX_BOX_RUNTIME_ROOT: f.root, SYNTHETIC_PRODUCT_CREDENTIAL: P_OWNER });
      const run = () => runCreationCanary({ plan, confirm: true, cli, ...files });
      const report = await run();
      assert.equal(report.creation.state, mode === "registration-unknown" ? "uncertain" : mode === "temporal" || mode === "unsupported" ? "failed" : mode === "stale" ? "stale" : mode === "no-authorization" ? "not-run" : "passed");
      assert.equal(report.cleanup.state, mode === "registration-unknown" || prevented ? "not-run" : mode === "cleanup-failed" ? "uncertain" : "passed");
      assert.equal(report.executionQualified, false);
      assert.equal(report.ok, mode === "passed" || mode === "response-lost");
      const writes = f.state.writes, nativeCalls = f.state.calls.length;
      assert.equal(f.state.factories, prevented ? 0 : 1); assert.equal(f.state.registrations, prevented ? 0 : 1);
      if (prevented) assert.equal(writes, 0);
      else if (mode !== "registration-unknown") assert.equal(writes, 2);
      assert.equal(f.state.calls.some(c => /sendPrompt|kickstart|Routine|Automation|createGroup|updateAgent/.test(c.method)), false);
      for (const call of f.state.calls.filter(c => c.method === "createAgent")) {
        assert.equal(call.input.isIntroductionSuppressed, true); assert.equal(call.input.isKickstartRequested, false);
      }
      for (const call of f.state.calls.filter(c => c.method === "deleteAgent")) assert.equal(call.input.id, report.targetId);
      if (!["registration-unknown", "no-authorization"].includes(mode)) assert.deepEqual([...f.state.rows.entries()], original);
      assert.deepEqual(await f.options.store.loadModels(), models);
      const again = await run(); assert.equal(f.state.writes, writes); assert.equal(f.state.factories, prevented ? 0 : 1);
      assert.equal(again.creation.state, report.creation.state); assert.equal(again.cleanup.state, report.cleanup.state);
      if (report.creation.state === "passed") assert.equal(again.lastSuccess, report.observedAtMs);
      if (mode === "passed") {
        const expired = await runCreationCanary({ plan, confirm: true, cli, ...files, now: () => report.observedAtMs + plan.maxAgeMs + 1 });
        assert.equal(expired.creation.state, "passed"); assert.equal(expired.freshness, "stale"); assert.equal(expired.status, "stale"); assert.equal(expired.ok, false);
        assert.equal(f.state.writes, writes);
      }
      if (mode === "no-authorization") assert.equal(f.state.calls.length, nativeCalls);
      const changed = { ...plan, requestId: randomUUID() };
      if (mode !== "no-authorization") await assert.rejects(runCreationCanary({ plan: changed, confirm: true, cli, ...files }), /original_plan_changed/);
      console.log(JSON.stringify({ scenario: mode, creation: report.creation, cleanup: report.cleanup, writes, factories: f.state.factories, registrations: f.state.registrations, liveEffects: false }));
    } finally { await f.close(); }
  });
}
