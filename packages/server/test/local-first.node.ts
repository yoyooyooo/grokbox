import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { productFixture, productCommand } from "./product-fixture.node.ts";

for (const mode of ["registered", "temporal", "registration-unknown", "response-lost"] as const) {
  test(`Local-first ${mode} uses management admission and preserves native creation separately from independent ownership`, async () => {
    const f = await productFixture(); f.state.localFirst = true;
    try {
      const intent = productCommand(), plan = (await f.client().previewProduct(intent)).data;
      f.state.registrationTemporal = mode === "temporal"; f.state.registrationError = mode === "registration-unknown";
      f.state.failAfterWrite = mode === "response-lost";
      const command = { ...intent, scopeId: plan.scopeId, expectedRevision: plan.revision, confirmed: true as const, acceptNonAtomic: true as const };
      const initial = (await f.client().submitProduct(command)).data;
      assert.equal(initial.state, mode === "response-lost" ? "effect_unknown" : "complete");
      f.state.failAfterWrite = false;
      const receipt = mode === "response-lost" ? (await f.client().reconcileProduct({ requestId: intent.requestId, scopeId: plan.scopeId })).data : initial;
      assert.equal(receipt.state, "complete");
      const r = receipt.result!.creation!;
      assert.equal(r.operationId, receipt.operationId); assert.equal(r.localAgentId, receipt.result!.targetId);
      assert.equal(r.outcome, mode === "temporal" ? "mismatch" : mode === "registration-unknown" ? "unknown" : "registered");
      assert.equal(r.firstResponse?.harness ?? null, mode === "temporal" ? "temporal" : mode === "registration-unknown" ? null : "box");
      const owner = (await f.client().productOwnership(r.localAgentId!)).data;
      assert.equal(owner.agents[0]!.state, mode === "temporal" ? "confirmed_temporal" : mode === "registration-unknown" ? "unconfirmed" : "confirmed_box");
      assert.equal(owner.executionQualified, false);
      assert.equal(f.state.factories, 1); assert.equal(f.state.registrations, 1); assert.equal(f.state.writes, 1);
      if (mode === "registration-unknown") {
        const retry = { ...intent, requestId: randomUUID() }, next = (await f.client().previewProduct(retry)).data;
        await assert.rejects(f.client().submitProduct({ ...retry, scopeId: next.scopeId, expectedRevision: next.revision,
          confirmed: true, acceptNonAtomic: true }), (error: any) => error.code === "idempotency_conflict");
      }
      await f.restart();
      assert.deepEqual((await f.client().productOperation({ requestId: intent.requestId, scopeId: plan.scopeId })).data, receipt);
      assert.deepEqual((await f.client().submitProduct(command)).data, receipt);
      assert.equal(f.state.writes, 1); assert.equal(f.state.cleanupCalls, 0);
      if (mode === "response-lost") assert.ok(f.state.calls.some(c => c.input.grokboxCreationRequestId === receipt.operationId));
    } finally { await f.close(); }
  });
}

test("missing loaded creation capability refuses before the native write", async () => {
  const f = await productFixture(); f.state.creationSupported = false;
  try {
    const intent = productCommand(), plan = (await f.client().previewProduct(intent)).data;
    const receipt = (await f.client().submitProduct({ ...intent, scopeId: plan.scopeId, expectedRevision: plan.revision, confirmed: true, acceptNonAtomic: true })).data;
    assert.equal(receipt.result?.nativeReceipt, "not-dispatched"); assert.equal(receipt.result?.targetId, null);
    assert.equal(f.state.writes, 0); assert.equal(f.state.factories, 0);
  } finally { await f.close(); }
});

test("an unknown old request cannot reconcile against a different local-first receipt or roster difference", async () => {
  const f = await productFixture();
  try {
    const intent = productCommand(), plan = (await f.client().previewProduct(intent)).data;
    f.state.failAfterWrite = true;
    const command = { ...intent, scopeId: plan.scopeId, expectedRevision: plan.revision, confirmed: true as const, acceptNonAtomic: true as const };
    const receipt = (await f.client().submitProduct(command)).data;
    f.state.failAfterWrite = false;
    assert.equal(receipt.state, "effect_unknown");
    assert.deepEqual((await f.client().reconcileProduct(command)).data, receipt);
    assert.equal(f.state.writes, 1);
  } finally { await f.close(); }
});
