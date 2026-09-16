import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import cliPackage from "../package.json" with { type: "json" };

const root = fileURLToPath(new URL("../", import.meta.url));

test("AH-97 opt-in validation topic teaches model-switch stay-green, not instant success", () => {
  const entry = readFileSync(join(root, "skills/grokbox/SKILL.md"), "utf8");
  const skill = readFileSync(join(root, "skills/grokbox/validation.md"), "utf8");
  const models = readFileSync(join(root, "skills/grokbox/models.md"), "utf8");
  const observation = readFileSync(join(root, "docs/maintainers/run-outcome-observation.md"), "utf8");
  expect(entry).toContain("[validation](validation.md)");
  expect(entry).not.toContain("grokbox models use <model-id> --for model-dogfood");
  expect(skill).toContain("Prove a model switch");
  expect(skill).toContain("grokbox models use <model-id> --for model-dogfood");
  expect(skill).toContain("history outcome model-dogfood --nonce <clientNonce> --runtime");
  expect(skill).toContain("agents title sync");
  expect(skill).toMatch(/two minutes/);
  expect(skill).toContain("m=<alias-or-model>");
  expect(skill).not.toMatch(/data\.state\s*=\s*accepted/);
  expect(models).toContain("Stay-green after a switch");
  expect(models).toContain("agents title sync");
  expect(models).toContain("validation.md#prove-a-model-switch");
  expect(observation).toContain("换模防回归（AH-97）");
  expect(observation).toContain("~120s");
  expect(observation).toContain("history outcome model-dogfood --nonce <clientNonce> --runtime");
});

test("AH-97 packaged modeld dogfood path is Node dist, not worktree TypeScript", () => {
  expect(cliPackage.scripts["modeld:run"]).toBe("node scripts/run-packaged-modeld.mjs --json");
  const script = readFileSync(join(root, "scripts/run-packaged-modeld.mjs"), "utf8");
  expect(script).toContain("dist/index.js");
  expect(script).toContain("bun run build");
  expect(script).toContain("runtime");
  expect(script).toContain("modeld");
  expect(script).toContain("run");
  expect(script).not.toContain("packages/cli/src/index.ts");
  const architecture = readFileSync(join(root, "docs/architecture.md"), "utf8");
  const core = readFileSync(join(root, "skills/core.md"), "utf8");
  expect(architecture).toContain("bun run modeld:run");
  expect(architecture).toContain("worktree TypeScript");
  expect(core).toContain("bun run modeld:run");
  expect(core).toContain("node dist/index.js runtime modeld run");
});
