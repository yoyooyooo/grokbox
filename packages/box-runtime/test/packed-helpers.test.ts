import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ensurePackedCli } from "../../../test/packed-cli-fixture.ts";
import { resolveNodeRequireablePreload, resolveRuntimeHelpers, RUNTIME_HELPER_FILES,
  RUNTIME_HELPER_GUARDIAN_CHILD, RUNTIME_HELPER_INJECTOR_HOLD, RUNTIME_HELPER_PRELOAD,
  RUNTIME_HELPER_TEMP_SUPERVISOR } from "../src/internal/process/helpers/runtime-helpers.ts";

const SRC = dirname(fileURLToPath(new URL("../src/internal/process/helpers/runtime-helpers.ts", import.meta.url)));
const roots: string[] = [];
beforeAll(() => { ensurePackedCli(); }, 90000);
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const directory = async () => { const root = await mkdtemp(join(tmpdir(), "grokbox-helper-layout-")); roots.push(root); return root; };
describe("current runtime helper published layout", () => {
  test("source helpers use their own built CJS preload, never a TypeScript fallback", () => {
    const helpers = resolveRuntimeHelpers();
    expect(helpers.preload).toBe(fileURLToPath(new URL("../../../dist/preload.cjs", import.meta.url)));
    expect(existsSync(helpers.preload)).toBe(true);
    expect(helpers.guardianChild).toBe(join(SRC, RUNTIME_HELPER_GUARDIAN_CHILD));
    expect(helpers.injectorHold).toBe(join(SRC, RUNTIME_HELPER_INJECTOR_HOLD));
    expect(helpers.tempSupervisor).toBe(join(SRC, RUNTIME_HELPER_TEMP_SUPERVISOR));
    for (const path of Object.values(helpers)) expect(existsSync(path)).toBe(true);
  });
  test("an installed layout resolves only its own sibling helpers", async () => {
    const dist = await directory(), index = pathToFileURL(join(dist, "index.js")).href;
    await writeFile(join(dist, RUNTIME_HELPER_PRELOAD), "module.exports = {};\n");
    for (const name of [RUNTIME_HELPER_GUARDIAN_CHILD, RUNTIME_HELPER_INJECTOR_HOLD, RUNTIME_HELPER_TEMP_SUPERVISOR]) await copyFile(join(SRC, name), join(dist, name));
    expect(resolveRuntimeHelpers(index).preload).toBe(join(dist, RUNTIME_HELPER_PRELOAD));
    for (const name of RUNTIME_HELPER_FILES) expect(existsSync(join(dist, name))).toBe(true);
  });
  test("missing installed CJS cannot borrow the checkout build or a source fallback", async () => {
    const dist = await directory(), index = pathToFileURL(join(dist, "index.js")).href;
    await writeFile(join(dist, "preload.ts"), "throw Error('must not execute');\n");
    expect(existsSync(resolveNodeRequireablePreload())).toBe(true);
    expect(() => resolveNodeRequireablePreload(index)).toThrow("runtime_preload_missing");
    expect(() => resolveRuntimeHelpers(index)).toThrow("runtime_preload_missing");
  });
});
