import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeProfileFile } from "../packages/cli/src/config/profile.ts";
import type { CliDeps } from "../packages/cli/src/deps.ts";
import { packAgentRecipe } from "../packages/cli/src/template-recipe.ts";
import { captureCli, parseJson, startMockGateway, writeDiscovery } from "./helpers.ts";

const AGENT = "11111111-1111-4111-8111-111111111111";

async function setup() {
  const gateway = await startMockGateway({
    agents: [{ id: AGENT, name: "probe", isGroup: false, title: "", harness: "box" }],
  });
  const dir = await mkdtemp(join(tmpdir(), "grokbox-template-"));
  const discoveryPath = await writeDiscovery({
    port: gateway.port,
    pid: gateway.pid,
    startedAt: gateway.startedAt,
    token: gateway.token,
  });
  const agentData = join(dir, "agent-data");
  await mkdir(join(agentData, AGENT, "memory", "log"), { recursive: true });
  await writeFile(join(agentData, AGENT, "profile.json"), JSON.stringify({
    name: "probe",
    description: "Template probe",
    avatarShape: "wedge",
    avatarColor: "violet",
  }));
  await writeFile(join(agentData, AGENT, "memory", "profile.md"), "Keep conventions.\n[episode] skip me\n");
  const deps: Partial<CliDeps> = {
    configDir: dir,
    discoveryPath,
    env: {},
    transport: "local",
    stdinIsTTY: false,
    daemonSocket: join(dir, "missing.sock"),
  };
  await writeProfileFile(dir, "default", { version: 1, transport: "local", gateway_discovery: discoveryPath });
  return { gateway, dir, agentData, deps };
}

test("packAgentRecipe skips episode lines and keeps profile facts", async () => {
  const root = await mkdtemp(join(tmpdir(), "grokbox-recipe-"));
  await mkdir(join(root, "memory", "log"), { recursive: true });
  await writeFile(join(root, "profile.json"), JSON.stringify({ name: "g", description: "d" }));
  await writeFile(join(root, "memory", "profile.md"), "Job fact.\n[episode] secret day\n");
  const recipe = await packAgentRecipe(root);
  expect(recipe.profile).toEqual({ name: "g", description: "d" });
  expect(recipe.memory).toEqual([{ kind: "profile", content: "Job fact." }]);
});

test("template pack writes recipe json from a local Bot", async () => {
  const { gateway, agentData, deps } = await setup();
  try {
    const out = join(agentData, "recipe.json");
    const result = await captureCli(["template", "pack", "probe", "--out", out, "--agent-data", agentData], deps);
    expect(result.code, result.stderr).toBe(0);
    const recipe = JSON.parse(await readFile(out, "utf8")) as { profile: { name: string }; memory: unknown[] };
    expect(recipe.profile.name).toBe("probe");
    expect(recipe.memory).toEqual([{ kind: "profile", content: "Keep conventions." }]);
  } finally {
    gateway.stop();
  }
});

test("template publish without --yes is invalid usage", async () => {
  const { gateway, deps } = await setup();
  try {
    const result = await captureCli(["template", "publish", "mnkXhILnzOakS0cDtKXPk", "--rev", "1"], deps);
    expect(result.code).toBe(2);
  } finally {
    gateway.stop();
  }
});

test("template stage without --yes is invalid usage", async () => {
  const { gateway, deps } = await setup();
  try {
    const result = await captureCli(["template", "stage", "probe", "--visibility", "public"], deps);
    expect(result.code).toBe(2);
  } finally {
    gateway.stop();
  }
});
