import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const checker = join(repoRoot, "scripts", "check-runtime-boundaries.mjs");

async function runChecker(root: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(["bun", checker, "--root", root, "--json"], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

async function fixture(setup: (root: string) => Promise<void>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "t20-boundary-"));
  await mkdir(join(root, "packages", "box-runtime", "src", "internal", "host"), { recursive: true });
  await mkdir(join(root, "packages", "runtime-kernel", "src"), { recursive: true });
  await mkdir(join(root, "packages", "cli", "src"), { recursive: true });
  await writeFile(
    join(root, "packages", "box-runtime", "package.json"),
    `${JSON.stringify({ name: "@grokbox/box-runtime", private: true, exports: { "./runtime": "./src/runtime.ts" } })}\n`,
  );
  await writeFile(
    join(root, "packages", "runtime-kernel", "package.json"),
    `${JSON.stringify({
      name: "@grokbox/runtime-kernel",
      private: true,
      exports: { "./contract": "./src/contract.ts", "./hash": "./src/hash.ts", "./selection": "./src/selection.ts", "./ports": "./src/ports.ts" },
    })}\n`,
  );
  await writeFile(join(root, "packages", "box-runtime", "src", "runtime.ts"), "export {}\n");
  await writeFile(join(root, "packages", "box-runtime", "src", "preload.ts"), "export {}\n");
  await writeFile(join(root, "packages", "runtime-kernel", "src", "contract.ts"), "export {}\n");
  await writeFile(join(root, "packages", "runtime-kernel", "src", "hash.ts"), "export {}\n");
  await writeFile(join(root, "packages", "runtime-kernel", "src", "selection.ts"), "export {}\n");
  await writeFile(join(root, "packages", "runtime-kernel", "src", "ports.ts"), "export {}\n");
  await writeFile(join(root, "packages", "cli", "src", "index.ts"), "export {}\n");
  await setup(root);
  return root;
}

describe("runtime layout boundaries", () => {
  test("repository layout checker is green", async () => {
    const result = await runChecker(repoRoot);
    expect(result.code, result.stderr + result.stdout).toBe(0);
  });

  test("forbidden Host Effect import is a non-zero checker", async () => {
    const root = await fixture(async (root) => {
      await writeFile(
        join(root, "packages", "box-runtime", "src", "internal", "host", "bad.ts"),
        `import { Effect } from "effect";\nexport const x = Effect;\n`,
      );
    });
    const result = await runChecker(root);
    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/Host leaf imports Effect\/SDK/);
  });

  test("production bun:* import is a non-zero checker", async () => {
    const root = await fixture(async (root) => {
      await writeFile(
        join(root, "packages", "box-runtime", "src", "runtime.ts"),
        `import { sqlite } from "bun:sqlite";\nexport const db = sqlite;\n`,
      );
    });
    const result = await runChecker(root);
    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/bun:\*|Bun globals/);
  });

  test("retired index barrel is a non-zero checker", async () => {
    const root = await fixture(async (root) => {
      await writeFile(join(root, "packages", "box-runtime", "src", "index.ts"), "export * from \"./runtime.ts\";\n");
      await writeFile(
        join(root, "packages", "box-runtime", "package.json"),
        `${JSON.stringify({ name: "@grokbox/box-runtime", private: true, exports: { ".": "./src/index.ts", "./runtime": "./src/runtime.ts" } })}\n`,
      );
    });
    const result = await runChecker(root);
    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/retired POC|root barrel/);
  });

  test("preload importing runtime.ts is a non-zero checker", async () => {
    const root = await fixture(async (root) => {
      await writeFile(
        join(root, "packages", "box-runtime", "src", "preload.ts"),
        `import { openRuntimeStore } from "./runtime.ts";\nvoid openRuntimeStore;\n`,
      );
    });
    const result = await runChecker(root);
    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/must not import runtime facade/);
  });
});
