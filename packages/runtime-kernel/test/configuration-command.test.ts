import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { runConfigurationSave } from "@grokbox/runtime-kernel/commands";
import { ConfigurationRead } from "@grokbox/runtime-kernel/ports";
import { STUB_ECHO_MODEL_ID, parseDesiredFile, parseModelsFile } from "@grokbox/runtime-kernel/selection";
import { fakeConfigurationReadLayer, fakeConfigurationWriteLayer } from "@grokbox/runtime-kernel/testing";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";

const models = parseModelsFile({
  version: 3,
  models: { [STUB_ECHO_MODEL_ID]: { provider: "stub", model: "echo", endpoint: "stub:echo", apiKeyRef: "" } },
  assignments: { main: { modelId: STUB_ECHO_MODEL_ID }, agents: {} },
});
const desired = parseDesiredFile({ version: 1, mode: "observe" });

function run(request: Parameters<typeof runConfigurationSave>[0], writes = { models: 0, desired: 0 }) {
  return Effect.runPromise(
    runConfigurationSave(request).pipe(Effect.provide(fakeConfigurationWriteLayer({ writes }))),
  ).then((receipt) => ({ receipt, writes }));
}

describe("T29 configuration command", () => {
  test("saveModels returns configRevision over ConfigurationWrite", async () => {
    const { receipt, writes } = await run({ boxRoot: "/tmp/box-local", kind: "models", file: models });
    expect(receipt).toMatchObject({ ok: true, kind: "models", boxRoot: "/tmp/box-local" });
    if (!receipt.ok) return;
    expect(receipt.configRevision).toBe(sha256Text(canonicalJson(models)));
    expect(writes).toEqual({ models: 1, desired: 0 });
  });

  test("saveDesired is the same program", async () => {
    const { receipt, writes } = await run({ boxRoot: "/workspace/.grokbox/box-runtime", kind: "desired", file: desired });
    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;
    expect(receipt.kind).toBe("desired");
    expect(receipt.configRevision).toBe(sha256Text(canonicalJson(desired)));
    expect(writes.desired).toBe(1);
    expect(writes.models).toBe(0);
  });

  test("remote or relative boxRoot refuses with zero writes", async () => {
    const writes = { models: 0, desired: 0 };
    for (const boxRoot of ["https://example.com/box", "ssh://host/root", "git@host:repo", "relative/root", ""]) {
      const { receipt } = await run({ boxRoot, kind: "models", file: models }, writes);
      expect(receipt.ok).toBe(false);
      if (receipt.ok) return;
      expect(["remote-box-root", "invalid-box-root"]).toContain(receipt.reason);
    }
    expect(writes).toEqual({ models: 0, desired: 0 });
  });

  test("readonly ConfigurationRead snapshot does not write", async () => {
    const writes = { models: 0, desired: 0 };
    const snapshot = await Effect.runPromise(
      Effect.gen(function* () {
        const read = yield* ConfigurationRead;
        return yield* read.snapshot();
      }).pipe(
        Effect.provide(fakeConfigurationReadLayer({ models: () => models })),
        Effect.provide(fakeConfigurationWriteLayer({ writes })),
      ),
    );
    expect(snapshot.models.assignments.main?.modelId).toBe(STUB_ECHO_MODEL_ID);
    expect(writes).toEqual({ models: 0, desired: 0 });
  });
});
