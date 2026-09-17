import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = resolve(root, "scripts/verify-modeld-core.mjs");
const moduleUrl = pathToFileURL(entry).href;
const verifier = await import(moduleUrl) as {
  MODEL_CORE_CASES: Record<string, string[] | null>;
  resolveCoreCase: (args: string[]) => { name: string; files: string[] };
  isolatedProofEnvironment: (env: Record<string, string>, home: string) => Record<string, string>;
  assertProofSuites: (directory: string, files: string[]) => void;
  proofProcessSucceeded: (result: { status: number | null; signal?: string | null; error?: Error }) => boolean;
};

test("modeld proof routing requires one known, implemented, nonempty case", () => {
  expect(verifier.resolveCoreCase(["--", "baseline"]).name).toBe("baseline");
  const selected = verifier.resolveCoreCase(["baseline"]);
  expect(selected.files.length).toBeGreaterThan(0);
  expect(new Set(selected.files).size).toBe(selected.files.length);
  for (const file of selected.files) {
    expect(file.endsWith(".test.ts")).toBe(true);
    expect(existsSync(resolve(root, file))).toBe(true);
  }
  for (const args of [[], ["not-a-case"], ["baseline", "--filter"], ["../../anything"], ["--", "--", "baseline"]]) {
    expect(() => verifier.resolveCoreCase(args)).toThrow();
  }
  for (const [name, files] of Object.entries(verifier.MODEL_CORE_CASES)) {
    if (files === null) expect(() => verifier.resolveCoreCase([name])).toThrow("not implemented");
  }
});

test("missing suites, nonzero child status and unknown settlement never pass a proof", () => {
  expect(() => verifier.assertProofSuites(root, [])).toThrow("Empty");
  expect(() => verifier.assertProofSuites(root, ["test/missing-modeld-required-proof.test.ts"])).toThrow();
  expect(verifier.proofProcessSucceeded({ status: 0 })).toBe(true);
  for (const result of [{ status: 1 }, { status: null }, { status: 0, signal: "SIGTERM" },
    { status: 0, error: new Error("timeout") }]) expect(verifier.proofProcessSucceeded(result)).toBe(false);
});

test("Node cannot masquerade as the pinned Bun proof toolchain", () => {
  const result = spawnSync("node", [entry, "baseline"], { cwd: root, encoding: "utf8" });
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("Proof requires declared Bun");
  expect(result.stdout).not.toContain("passed-offline");
});

test("proof process strips credential and live qualification environment without changing caller", () => {
  const env = { PATH: "/fixture/bin", HOME: "/fixture/original", OPENAI_API_KEY: "PRIVATE_SENTINEL",
    CUSTOM_TOKEN: "PRIVATE_SENTINEL", GROKBOX_TEST_NATIVE_HOST: "1", GROKBOX_MODELD_HOST_COMPACT: "1",
    PI_CODING_AGENT_DIR: "/fixture/pi", AWS_PROFILE: "fixture", USER: "fixture" };
  const isolated = verifier.isolatedProofEnvironment(env, "/fixture/proof-root");
  expect(isolated.HOME).toBe("/fixture/proof-root");
  expect(isolated.XDG_CONFIG_HOME).toBe("/fixture/proof-root/.config");
  expect(isolated.GROKBOX_TEST_NATIVE_HOST).toBe("0");
  expect(isolated.GROKBOX_MODELD_HOST_COMPACT).toBeUndefined();
  expect(isolated.PI_CODING_AGENT_DIR).toBeUndefined();
  expect(isolated.AWS_PROFILE).toBeUndefined();
  expect(JSON.stringify(isolated)).not.toContain("PRIVATE_SENTINEL");
  expect(env.GROKBOX_TEST_NATIVE_HOST).toBe("1");
  expect(isolated.PATH).toBe(env.PATH);
});

test("unknown modeld proof case exits nonzero without running or declaring a passed gate", () => {
  const result = spawnSync(process.execPath, [entry, "unknown"], { cwd: root, encoding: "utf8" });
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("Expected exactly one case");
  expect(result.stdout).not.toContain("passed-offline");
});

test("live-only acceptance has one discoverable cross-worktree home rather than a code-review waiver", () => {
  const file = "docs/tickets/LIVE-integration-validation.md";
  const text = readFileSync(resolve(root, file), "utf8");
  for (const router of ["AGENTS.md", "docs/README.md", "docs/tickets/README.md", "docs/maintainers/release.md",
    "docs/tickets/T49-modeld-qualification-and-release.md", "docs/tickets/T50-modeld-review-residue.md"]) {
    expect(readFileSync(resolve(root, router), "utf8")).toContain("LIVE-integration-validation.md");
  }
  const anchors = [...text.matchAll(/<a id="(live-modeld-[a-z-]+)"><\/a>/g)].map(match => match[1]);
  expect(anchors).toHaveLength(6); expect(new Set(anchors).size).toBe(6);
  // The current LIVE home is a per-dimension table, not the former sections
  // plus a duplicated navigation list. Every stable anchor must retain a real
  // row with evidence, an explicit gap, a next action and its source links.
  for (const id of anchors) {
    const rows = text.split("\n").filter(line => line.startsWith("| ") && line.includes(`<a id="${id}"></a>`));
    expect(rows).toHaveLength(1);
    const cells = rows[0]!.split("|").slice(1, -1).map(cell => cell.trim());
    expect(cells).toHaveLength(4);
    expect(cells.every(cell => cell.length > 0)).toBe(true);
    expect(cells[0]).toContain(id.toUpperCase());
    expect(cells[3]).toMatch(/\]\([^)]*\.md(?:#[^)]*)?\)/);
    expect(cells[3]).toMatch(/`(?:awaiting-integration|ready|running|passed|failed|blocked|needs-revalidation|superseded)`/);
  }
  expect(text).toContain("awaiting-integration");
  expect(text).toContain("needs-revalidation");
  expect(text).toContain("feat/box-runtime-v2");
  expect(text).toContain("不把未实现代码或 review 改称 live 待办");
});

test("modeld specification has one owning section and all implementation tickets route to it", () => {
  const spec = readFileSync(resolve(root, "docs/roadmap/box-runtime-impl-spec.md"), "utf8");
  expect(spec.match(/<a id="modeld-effect-core"><\/a>/g)?.length).toBe(1);
  const tickets = [
    "T43-modeld-authority-baseline", "T44-modeld-service-lifetime", "T45-modeld-evidence-lifetime",
    "T46-modeld-state-and-durability", "T47-modeld-authority-state-machine", "T48-modeld-causal-observation",
    "T49-modeld-qualification-and-release", "T50-modeld-review-residue",
  ];
  const index = readFileSync(resolve(root, "docs/tickets/README.md"), "utf8");
  for (const ticket of tickets) {
    const text = readFileSync(resolve(root, `docs/tickets/${ticket}.md`), "utf8");
    expect(text).toContain("box-runtime-impl-spec.md#modeld-effect-core");
    expect(text).toContain("Status:");
    expect(index).toContain(`${ticket}.md`);
  }
});
