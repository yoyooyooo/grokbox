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

describe("one public model command family", () => {
  test("model checks and credential persistence are top-level with no runtime model aliases", async () => {
    const paths = LEAF_COMMANDS.map((leaf) => leaf.path.join(" "));
    for (const leaf of ["check", "list", "use", "reset", "persist-key", "show", "migrate"]) expect(paths).toContain(`models ${leaf}`);
    expect(paths.some((path) => path.startsWith("runtime models "))).toBe(false);
    const f = await fixture();
    const checked = await captureCli(["models", "check"], f.deps);
    expect(checked.code, checked.stderr).toBe(0);
    expect(parseJson(checked.stdout)).toMatchObject({ data: { checked: ["schema"], serviceReadiness: "not_checked" } });
    expect((await captureCli(["runtime", "models", "check"], f.deps)).code).not.toBe(0);
    expect(await readFile(join(f.root, "models.json"), "utf8")).toBe(f.body);
  });
  test("ambiguous selection refuses before model writes; explicit default never assigns a Bot", async () => {
    const f = await fixture();
    for (const args of [["use", "stub/echo"], ["reset"], ["use", "stub/echo", "--default", "--for", "00000000-0000-4000-8000-000000000123"]]) {
      const refused = await captureCli(["models", ...args], f.deps);
      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toContain("exactly one");
      expect(await readFile(join(f.root, "models.json"), "utf8")).toBe(f.body);
    }
    const chosen = await captureCli(["models", "use", "stub/echo", "--default"], f.deps);
    expect(chosen.code, chosen.stderr).toBe(0);
    expect(JSON.parse(await readFile(join(f.root, "models.json"), "utf8")).assignments).toEqual({ main: { modelId: "stub/echo" }, agents: {} });
    const reset = await captureCli(["models", "reset", "--default"], f.deps);
    expect(reset.code, reset.stderr).toBe(0);
    expect(JSON.parse(await readFile(join(f.root, "models.json"), "utf8")).assignments).toEqual({ main: null, agents: {} });
  });
});
