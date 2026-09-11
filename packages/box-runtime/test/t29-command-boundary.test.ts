import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigurationWrite } from "@grokbox/runtime-kernel/ports";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("T29 command boundary incubate (no browser, no fake CAS)", () => {
  test("later/T29-only console assets are not scaffolded", () => {
    expect(existsSync(join(repoRoot, "packages/box-runtime/src/internal/console"))).toBe(false);
    expect(existsSync(join(repoRoot, "packages/box-runtime/src/internal/roots/console.runtime.ts"))).toBe(false);
    expect(existsSync(join(repoRoot, "packages/cli/src/commands/runtime-roster.ts"))).toBe(false);
  });

  test("ConfigurationWrite is the config-write port; IO is still single-writer atomic save", () => {
    expect(ConfigurationWrite.key).toBe("grokbox/ConfigurationWrite");
    const io = readFileSync(join(repoRoot, "packages/box-runtime/src/internal/io/configuration.node.ts"), "utf8");
    expect(io).toContain("writeJsonAtomic");
    expect(io).toContain("saveModels");
    expect(io).not.toContain("expectedConfigRevision");
    expect(io).not.toContain("configRevision");
    expect(io).not.toMatch(/\bfcntl\b|\bflock\b/);
    const commands = readFileSync(join(repoRoot, "packages/runtime-kernel/src/commands.ts"), "utf8");
    expect(commands).toContain("runControllerOperation");
    expect(commands).not.toContain("saveModels");
  });
});
