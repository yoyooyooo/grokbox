import { describe, expect, test } from "bun:test";
import { readdir, readFile, lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as runtime from "../src/runtime.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const retiredFiles = ["internal/roots/controller.runtime.ts", "internal/process/live-inject.ts", "internal/process/live-readopt.ts"];
const retiredNames = ["runWatchdogTick", "runWatchdogCutover", "runManualReadopt", "runLiveIdentityInject", "runLiveIdentityDeactivate", "runIdentityChainInject", "wireLiveManualReadopt", "WatchdogAdoptPorts", "ManualReadoptInput"];
async function walk(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (/\.(?:ts|tsx|js|mjs|cjs)$/.test(entry.name)) files.push(path);
  }
  return files;
}

describe("current control ownership has no retired executor or compatibility tombstone", () => {
  test("retired source files are absent, not retained as throwing shims", async () => {
    for (const path of retiredFiles) await expect(lstat(join(root, "packages/box-runtime/src", path))).rejects.toMatchObject({ code: "ENOENT" });
  });
  test("all production consumers are detached from removed signatures and wiring", async () => {
    const files = (await Promise.all(["packages/box-runtime/src", "packages/cli/src", "packages/server/src", "packages/client/src", "apps/web/src"].map(path => walk(join(root, path))))).flat();
    for (const path of files) {
      const source = await readFile(path, "utf8");
      for (const name of retiredNames) expect(source.includes(name), `${path}: ${name}`).toBe(false);
      for (const name of ["/controller.runtime", "/live-inject", "/live-readopt"]) expect(source.includes(name), `${path}: ${name}`).toBe(false);
    }
  });
  test("the public package exposes the actual current controller rather than old aliases", () => {
    for (const name of retiredNames) expect(Object.hasOwn(runtime, name)).toBe(false);
    expect(typeof runtime.startControlOperation).toBe("function");
    expect(typeof runtime.recoverControllerOperationState).toBe("function");
    expect(typeof runtime.controllerOperationId).toBe("function");
  });
});
