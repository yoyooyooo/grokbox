import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEAF_COMMANDS } from "../packages/cli/src/registry.ts";
import { captureCli, parseJson } from "./helpers.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "grokbox-models-surface-"));
  const body = '{"version":1,"models":{},"assignments":{"main":null,"agents":{}}}\n';
  await writeFile(join(root, "models.json"), body, { mode: 0o600 });
  return { root, body, deps: { boxRuntimeRoot: root, configDir: root, discoveryPath: "/dev/null" } };
}

describe("one management model selection surface", () => {
  test("new model choices require caller identity and revision; retired paths have no aliases", async () => {
    const paths = LEAF_COMMANDS.map(leaf => leaf.path.join(" "));
    for (const path of ["model list", "model get", "bot model get", "bot model set", "bot model reset", "model default get", "model default set", "model default reset", "operation get"]) {
      expect(paths).toContain(path);
    }
    for (const name of ["list", "use", "show", "reset"]) expect(paths).not.toContain(`models ${name}`);
    expect(paths.some(path => path.startsWith("runtime models "))).toBe(false);
    for (const path of ["bot model set", "bot model reset", "model default set", "model default reset"]) {
      const leaf = LEAF_COMMANDS.find(leaf => leaf.path.join(" ") === path)!;
      expect(leaf.options.some(option => option.flags.startsWith("--request-id") && option.required)).toBe(true);
      expect(leaf.options.some(option => option.flags.startsWith("--expect-revision") && option.required)).toBe(true);
    }
    const f = await fixture();
    for (const args of [["models", "use", "stub/echo", "--default"], ["models", "reset", "--default"], ["models", "list"], ["models", "show", "--for", "11111111-1111-4111-8111-111111111111"]]) {
      expect((await captureCli(args, f.deps)).code).toBe(2);
      expect(await readFile(join(f.root, "models.json"), "utf8")).toBe(f.body);
    }
  });
  test("unbound management commands do not fall back to local model files; maintenance checks remain read-only", async () => {
    const f = await fixture();
    const queried = await captureCli(["model", "list"], f.deps);
    expect(queried.code).toBe(7); expect(queried.stderr).toBe("");
    expect(parseJson(queried.stdout)).toMatchObject({ ok: false, error: { code: "unavailable" } });
    const checked = await captureCli(["models", "check"], f.deps);
    expect(checked.code, checked.stderr).toBe(0);
    expect(parseJson(checked.stdout)).toMatchObject({ data: { checked: ["schema"], serviceReadiness: "not_checked" } });
    expect(await readFile(join(f.root, "models.json"), "utf8")).toBe(f.body);
  });
});
