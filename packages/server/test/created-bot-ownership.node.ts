import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { productFixture, P_OWNER, P_B, P_SCOPE } from "./product-fixture.node.ts";
import { ownedOwnershipSnapshot } from "../../box-runtime/test/ownership-fixture.ts";

for (const mode of ["box", "temporal", "confirmed-temporal", "old", "failure", "wrong-id"] as const) {
  test(`current creation and independent ${mode} ownership retain one original identity without enabling a model`, { timeout: 25000 }, async () => {
    const f = await productFixture();
    const initialIds = new Set(f.state.rows.keys());
    let createdId: string | undefined;
    async function cli(args: string[], expected = 0) {
      const child = spawn("node", [process.env.GROKBOX_TEST_CLI_ENTRY!, ...args], { cwd: f.root,
        env: { PATH: process.env.PATH, HOME: f.root, GROKBOX_CONFIG_DIR: f.root, GROKBOX_BOX_RUNTIME_ROOT: f.root, SYNTHETIC_PRODUCT_CREDENTIAL: P_OWNER },
        stdio: ["ignore", "pipe", "pipe"], timeout: 12000 });
      let out = "", err = ""; child.stdout.on("data", bytes => out += bytes); child.stderr.on("data", bytes => err += bytes);
      const [code, signal] = await once(child, "close"); assert.equal(signal, null, out + err); assert.equal(code, expected, out + err);
      assert.ok(!out.includes(f.state.token)); return JSON.parse(out || err);
    }
    try {
      const modelsBefore = await f.options.store.loadModels();
      const requestId = randomUUID(), file = join(f.root, "creation.json");
      await writeFile(file, JSON.stringify({ requestId, profile: { name: "Owned creation" }, harness: "box", deferStart: true }), { mode: 0o600 });
      const plan = (await cli(["bot", "create", "--input", `@${file}`, "--preview"])).data;
      assert.equal(f.state.writes, 0); assert.equal(plan.nativeEffectsPerformed, false);
      f.state.afterWrite = async () => {
        const created = [...f.state.rows.keys()].filter(id => !initialIds.has(id)); assert.equal(created.length, 1); createdId = created[0]!;
        if (mode === "confirmed-temporal") f.state.rows.get(createdId)!.harness = "temporal";
        f.state.ownershipTransform = (proof, ids) => {
          assert.deepEqual(ids, [createdId], "post-create ownership must request the native returned ID");
          if (mode === "old") return { version: "old" };
          if (mode === "failure") throw Error("synthetic-ownership-read-failure");
          if (mode === "wrong-id") return ownedOwnershipSnapshot([P_B], { scopeId: P_SCOPE });
          if (mode === "temporal") for (const row of proof.agents) row.server.harness = "temporal";
          return proof;
        };
      };
      const args = ["bot", "create", "--input", `@${file}`, "--scope-id", plan.scopeId, "--expect-revision", plan.revision, "--accept-non-atomic", "--confirm"];
      const receipt = (await cli(args)).data;
      assert.equal(receipt.requestId, requestId); assert.equal(receipt.state, "complete");
      assert.ok(createdId); assert.equal(receipt.result.targetId, createdId); assert.equal(receipt.result.nativeReceipt, "returned");
      assert.equal(receipt.result.fullClone, false); assert.equal(receipt.result.relationshipsTransferred, false);
      // Product readback compares the roster object to the declared create intent.
      // Server/local ownership agreement is checked separately below; matched is
      // never permission to execute. A temporal roster differs from requested box.
      assert.equal(receipt.intent.harness, "box");
      if (mode === "old" || mode === "failure") assert.equal(receipt.result.object, null);
      else {
        assert.equal(receipt.result.object.id, createdId);
        assert.equal(receipt.result.object.harness, mode === "confirmed-temporal" ? "temporal" : "box");
      }
      assert.equal(receipt.result.readBack, mode === "old" || mode === "failure" ? "not-observed" : mode === "confirmed-temporal" ? "mismatch" : "matched");
      const mint = f.state.calls.filter(call => call.method === "createAgent"); assert.equal(mint.length, 1);
      assert.equal(mint[0]!.input.clientNonce, receipt.operationId); assert.equal(mint[0]!.input.harness, "box");
      assert.equal(mint[0]!.input.isIntroductionSuppressed, true); assert.equal(mint[0]!.input.isKickstartRequested, false);
      if (mode === "old" || mode === "failure") {
        await assert.rejects(f.client().productOwnership(createdId), (error: any) => error?.code === "source_unavailable");
      } else {
        const ownership = (await f.client().productOwnership(createdId)).data;
        assert.equal(ownership.executionQualified, false); assert.equal(ownership.agents.length, 1);
        assert.equal(ownership.agents[0]!.id, createdId);
        assert.equal(ownership.agents[0]!.state, mode === "box" ? "confirmed_box" : mode === "temporal" ? "conflict" : mode === "confirmed-temporal" ? "confirmed_temporal" : "unconfirmed");
      }
      assert.deepEqual(await f.options.store.loadModels(), modelsBefore);
      const calls = f.state.calls.length; f.state.failNative = true;
      assert.deepEqual((await cli(args)).data, receipt); assert.equal(f.state.calls.length, calls);
      await f.restart(); assert.deepEqual((await f.client().productOperation({ requestId, scopeId: plan.scopeId })).data, receipt);
      assert.deepEqual((await cli(args)).data, receipt); assert.equal(f.state.calls.length, calls);
      const retired = await cli(["agents", "create", "--name", "owned", "--nonce", requestId, "--harness", "box"], 2);
      assert.equal(retired.error.code, "invalid_usage"); assert.equal(f.state.calls.length, calls);
      assert.equal(f.state.writes, 1); assert.equal(f.state.cleanupCalls, 0);
      assert.equal(f.state.calls.some(call => /delete|reconcile|sendPrompt|duplicate|updateAgent/.test(call.method)), false);
      assert.deepEqual(await f.options.store.loadModels(), modelsBefore);
    } finally { await f.close(); }
  });
}
