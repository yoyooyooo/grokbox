import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CONFIG_READ_MAX_BYTES } from "@grokbox/runtime-kernel/contract";
import { STUB_ECHO_MODEL_ID } from "@grokbox/runtime-kernel/selection";
import { bindHostSessionHook } from "../src/internal/host/session-hook.ts";
import { captureHostManagedSelection, captureHostSelection } from "../src/internal/host/selection.node.ts";
import { isHostManagedFailure, isHostPromptSession } from "../src/internal/host/session.ts";

const file = { version: 3, models: {}, assignments: { main: null, agents: { "owned-agent": { modelId: STUB_ECHO_MODEL_ID } } } };

for (const shape of ["missing", "malformed", "invalid-schema", "oversized", "directory", "symlink"] as const) {
  test(`route selection ${shape} refuses before the official executor, not an implicit model switch`, async () => {
    const root = await mkdtemp(join(tmpdir(), "grokbox-select-unavailable-"));
    try {
      const path = join(root, "models.json");
      if (shape === "malformed") await writeFile(path, "{PRIVATE_CONFIG_SENTINEL");
      if (shape === "invalid-schema") await writeFile(path, JSON.stringify({ ...file, version: 999, secret: "PRIVATE_CONFIG_SENTINEL" }));
      if (shape === "oversized") await writeFile(path, " ".repeat(CONFIG_READ_MAX_BYTES + 1));
      if (shape === "directory") await mkdir(path);
      if (shape === "symlink") {
        await writeFile(join(root, "target.json"), JSON.stringify(file));
        await symlink(join(root, "target.json"), path);
      }
      const before = shape === "malformed" ? await readFile(path, "utf8") : null;
      let officialCalls = 0;
      const official = { getExecutor() { officialCalls++; throw new Error("official_inference_forbidden"); } };
      const hook = bindHostSessionHook({ mode: "route", durableRoot: root, runRoot: join(root, "run") });
      let caught: unknown;
      try { hook({ agentId: "owned-agent", sessionOptions: { invocationId: "owned-turn" }, originalSession: official }); }
      catch (error) { caught = error; }
      expect(caught).toMatchObject({ code: "runtime_config_invalid" });
      expect(isHostManagedFailure(caught)).toBe(true);
      expect(String(caught)).not.toContain("PRIVATE_CONFIG_SENTINEL");
      expect(officialCalls).toBe(0);
      expect(() => captureHostManagedSelection(root, "owned-agent")).toThrow();
      expect(() => captureHostSelection(root, "owned-agent")).toThrow();
      // Known native auxiliary sessions have no managed Agent identity. They
      // must not acquire a dependency on the main-model config file.
      expect(hook({ originalSession: official })).toBe(official);
      expect(captureHostManagedSelection(root, undefined)).toEqual({ kind: "official" });
      for (const mode of ["observe", "identity"] as const) {
        expect(bindHostSessionHook({ mode, durableRoot: root, runRoot: root })({ agentId: "owned-agent", originalSession: official })).toBe(official);
      }
      if (before !== null) expect(await readFile(path, "utf8")).toBe(before);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test("invalid future selection never reclassifies an already captured managed session", async () => {
  const root = await mkdtemp(join(tmpdir(), "grokbox-select-frozen-"));
  try {
    await writeFile(join(root, "models.json"), JSON.stringify(file));
    const original = { kind: "owned-official" };
    const hook = bindHostSessionHook({ mode: "route", durableRoot: root, runRoot: root });
    const managed = hook({ agentId: "owned-agent", sessionOptions: { invocationId: "turn-before" }, originalSession: original });
    if (!isHostPromptSession(managed)) throw new Error("expected_managed_capture");
    expect(managed.getModelId()).toBe(STUB_ECHO_MODEL_ID);
    await writeFile(join(root, "models.json"), "{");
    expect(() => hook({ agentId: "owned-agent", sessionOptions: { invocationId: "turn-after" }, originalSession: original })).toThrow();
    expect(managed.getModelId()).toBe(STUB_ECHO_MODEL_ID);
    await writeFile(join(root, "models.json"), JSON.stringify({ ...file, assignments: { main: null, agents: {} } }));
    expect(hook({ agentId: "owned-agent", sessionOptions: { invocationId: "turn-reset" }, originalSession: original })).toBe(original);
    expect(managed.getModelId()).toBe(STUB_ECHO_MODEL_ID);
  } finally { await rm(root, { recursive: true, force: true }); }
});
