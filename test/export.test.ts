import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT_CODES } from "../packages/cli/src/errors.ts";
import { assertNoSecrets, captureCli, parseJson } from "./helpers.ts";

const GATEWAY_SECRET = "live-gateway-token-should-never-export";
const PLUGIN_SECRET = "secret-plugin-token";
const WORKFLOW_BODY = "# demo-workflow\n\nGlobal workflow body.\n";
const UNRELATED_BODY = "# unrelated-workflow\n\nMust not be packed by default.\n";

type Fixture = {
  agentData: string;
  parent: string;
};

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function writeText(path: string, content: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content.endsWith("\n") ? content : `${content}\n`, { mode: 0o600 });
}

async function makeFixture(rootName = "agent-data"): Promise<Fixture> {
  const parent = await mkdtemp(join(tmpdir(), "grokbox-export-"));
  const agentData = join(parent, rootName);
  await mkdir(join(agentData, "agents", "agent-alpha", "automations", "nightly"), { recursive: true });
  await mkdir(join(agentData, "agents", "agent-alpha", "memory", "log"), { recursive: true });
  await mkdir(join(agentData, "agents", "group-ops"), { recursive: true });
  await mkdir(join(agentData, "agents", "agent-beta"), { recursive: true });
  await mkdir(join(agentData, "agents", "agent-twin-a"), { recursive: true });
  await mkdir(join(agentData, "agents", "agent-twin-b"), { recursive: true });
  await mkdir(join(agentData, "user-memory", "by-agent", "agent-alpha"), { recursive: true });
  await mkdir(join(agentData, "projects", "demo", "memory", "by-agent", "agent-alpha", "log"), {
    recursive: true,
  });
  await mkdir(join(agentData, "workflows", "demo-workflow"), { recursive: true });
  await mkdir(join(agentData, "workflows", "unrelated-workflow"), { recursive: true });

  await writeJson(join(agentData, "gateway.json"), { token: GATEWAY_SECRET });
  await writeJson(join(agentData, "agents", "agent-alpha", "profile.json"), {
    name: "alpha",
    title: "Alpha",
    description: "research buddy",
    avatarShape: "circle",
    avatarColor: "blue",
  });
  await writeJson(join(agentData, "agents", "agent-alpha", "settings.json"), {
    notifyOnAgentUpdates: true,
    pluginToken: PLUGIN_SECRET,
  });
  await writeJson(join(agentData, "agents", "agent-alpha", "projects.json"), { projects: ["demo"] });
  await writeText(join(agentData, "agents", "agent-alpha", "store.db"), "sqlite-not-for-export");
  await writeJson(join(agentData, "agents", "agent-alpha", "gateway.json"), { token: GATEWAY_SECRET });
  await writeText(join(agentData, "agents", "agent-alpha", "memory", "profile.md"), "# Agent memory\n");
  await writeText(join(agentData, "agents", "agent-alpha", "memory", "log", "2026-08.md"), "- did work\n");
  await writeJson(join(agentData, "agents", "agent-alpha", "automations", "nightly", "automation.json"), {
    name: "nightly",
    prompt: "Read sand-workflow:demo-workflow and stay quiet if nothing changed.",
    enabled: true,
  });
  await writeJson(join(agentData, "agents", "group-ops", "profile.json"), { name: "ops", title: "Ops" });
  await writeJson(join(agentData, "agents", "group-ops", "group.json"), { memberIds: ["agent-alpha"] });
  await writeJson(join(agentData, "agents", "agent-beta", "profile.json"), { name: "beta" });
  await writeJson(join(agentData, "agents", "agent-twin-a", "profile.json"), { name: "twin", title: "Twin" });
  await writeJson(join(agentData, "agents", "agent-twin-b", "profile.json"), { name: "twin", title: "Twin B" });
  await writeText(join(agentData, "user-memory", "by-agent", "agent-alpha", "profile.md"), "# User shard\n");
  await writeText(
    join(agentData, "projects", "demo", "memory", "by-agent", "agent-alpha", "log", "2026-08.md"),
    "# Project shard\n",
  );
  await writeText(join(agentData, "workflows", "demo-workflow", "SKILL.md"), WORKFLOW_BODY);
  await writeText(join(agentData, "workflows", "unrelated-workflow", "SKILL.md"), UNRELATED_BODY);
  return { agentData, parent };
}

async function runExport(argv: string[], extraSecrets: string[] = []) {
  const result = await captureCli(argv, {
    now: () => Date.UTC(2026, 8, 6, 1, 0, 0),
    discoveryPath: "/dev/null",
  });
  assertNoSecrets(`${result.stdout}${result.stderr}`, extraSecrets);
  return result;
}

function errorCode(stderr: string): string {
  return (parseJson(stderr) as { error: { code: string } }).error.code;
}

describe("export agent", () => {
  test("exports owned files, classifies related workflow refs, and omits secrets", async () => {
    const fixture = await makeFixture();
    const out = join(fixture.parent, "out");
    const result = await runExport(
      ["export", "agent", "alpha", "--out", out, "--agent-data", fixture.agentData],
      [GATEWAY_SECRET, PLUGIN_SECRET],
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const body = parseJson(result.stdout) as {
      ok: true;
      data: {
        agentId: string;
        name: string;
        kind: string;
        owned: string[];
        related: Array<{ kind: string; name: string; association: string; present: boolean }>;
        unassociated: {
          skills: { association: string };
          workflows: { association: string };
          plugins: { association: string };
        };
        memoryLayers: string[];
        includedRelatedWorkflows: boolean;
        manifest: string;
      };
    };
    expect(body.data.agentId).toBe("agent-alpha");
    expect(body.data.name).toBe("alpha");
    expect(body.data.kind).toBe("agent");
    expect(body.data.memoryLayers).toEqual(["agent", "user", "project"]);
    expect(body.data.includedRelatedWorkflows).toBe(false);
    expect(body.data.unassociated).toEqual({
      skills: { association: "none" },
      workflows: { association: "none" },
      plugins: { association: "none" },
    });
    expect(body.data.related).toEqual([
      { kind: "workflow", name: "demo-workflow", association: "reference", present: true },
    ]);
    expect(body.data.owned).toContain("profile.json");
    expect(body.data.owned).toContain("settings.json");
    expect(body.data.owned).toContain("memory/agent/profile.md");
    expect(body.data.owned).toContain("memory/user/profile.md");
    expect(body.data.owned).toContain("memory/project/demo/log/2026-08.md");
    expect(body.data.owned).toContain("automations/nightly/automation.json");

    const manifest = JSON.parse(await readFile(join(out, "manifest.json"), "utf8")) as {
      related: Array<{ name: string; classification: string }>;
      omitted: Array<{ sourcePath: string }>;
      unassociated: { skills: { association: string }; plugins: { association: string } };
    };
    expect(manifest.related[0]?.classification).toBe("related");
    expect(manifest.unassociated.skills.association).toBe("none");
    expect(manifest.omitted.map((row) => row.sourcePath)).toContain("agents/agent-alpha/store.db");
    expect(manifest.omitted.map((row) => row.sourcePath)).toContain("gateway.json");

    const settings = JSON.parse(await readFile(join(out, "settings.json"), "utf8")) as Record<string, unknown>;
    expect(settings.notifyOnAgentUpdates).toBe(true);
    expect(settings.pluginToken).toBeUndefined();
    await expect(readFile(join(out, "store.db"), "utf8")).rejects.toThrow();
    await expect(readFile(join(out, "gateway.json"), "utf8")).rejects.toThrow();
    await expect(readFile(join(out, "related", "workflows", "demo-workflow", "SKILL.md"), "utf8")).rejects.toThrow();
    await expect(
      readFile(join(out, "related", "workflows", "unrelated-workflow", "SKILL.md"), "utf8"),
    ).rejects.toThrow();
    expect(await readFile(join(out, "memory", "agent", "profile.md"), "utf8")).toContain("Agent memory");
  });

  test("packs only referenced workflow bodies when opted in", async () => {
    const fixture = await makeFixture();
    const out = join(fixture.parent, "out-related");
    const result = await runExport(
      [
        "export",
        "agent",
        "agent-alpha",
        "--out",
        out,
        "--agent-data",
        fixture.agentData,
        "--include-related-workflows",
      ],
      [GATEWAY_SECRET, PLUGIN_SECRET],
    );
    expect(result.code).toBe(0);
    expect(await readFile(join(out, "related", "workflows", "demo-workflow", "SKILL.md"), "utf8")).toBe(
      WORKFLOW_BODY,
    );
    await expect(
      readFile(join(out, "related", "workflows", "unrelated-workflow", "SKILL.md"), "utf8"),
    ).rejects.toThrow();
    const body = parseJson(result.stdout) as { data: { includedRelatedWorkflows: boolean } };
    expect(body.data.includedRelatedWorkflows).toBe(true);
  });

  test("rejects groups, missing targets, and ambiguous names without reading live data", async () => {
    const fixture = await makeFixture();
    const missing = await runExport(
      ["export", "agent", "no-such-bot", "--out", join(fixture.parent, "missing"), "--agent-data", fixture.agentData],
    );
    expect(missing.code).toBe(17);
    expect(errorCode(missing.stderr)).toBe("target_not_found");

    const group = await runExport(
      ["export", "agent", "ops", "--out", join(fixture.parent, "group"), "--agent-data", fixture.agentData],
    );
    expect(group.code).toBe(18);
    expect(errorCode(group.stderr)).toBe("target_kind_mismatch");

    const ambiguous = await runExport(
      ["export", "agent", "twin", "--out", join(fixture.parent, "twin"), "--agent-data", fixture.agentData],
    );
    expect(ambiguous.code).toBe(19);
    expect(errorCode(ambiguous.stderr)).toBe("target_ambiguous");
  });

  test("fail-closes on non-empty destinations, product-tree paths, and secret paths", async () => {
    const fixture = await makeFixture();
    const nonempty = join(fixture.parent, "nonempty");
    await mkdir(nonempty);
    await writeFile(join(nonempty, "keep.txt"), "nope\n");
    const existsResult = await runExport(
      ["export", "agent", "alpha", "--out", nonempty, "--agent-data", fixture.agentData],
    );
    expect(existsResult.code).toBe(EXIT_CODES.export_destination_exists);
    expect(errorCode(existsResult.stderr)).toBe("export_destination_exists");

    const inside = await runExport(
      [
        "export",
        "agent",
        "alpha",
        "--out",
        join(fixture.agentData, "exported"),
        "--agent-data",
        fixture.agentData,
      ],
    );
    expect(inside.code).toBe(EXIT_CODES.export_forbidden);
    expect(errorCode(inside.stderr)).toBe("export_forbidden");

    const secretOut = join(fixture.parent, "gateway.json");
    const secret = await runExport(
      ["export", "agent", "alpha", "--out", secretOut, "--agent-data", fixture.agentData],
    );
    expect(secret.code).toBe(EXIT_CODES.export_forbidden);
    expect(errorCode(secret.stderr)).toBe("export_forbidden");
  });

  test("allows an existing empty destination and refuses escaping memory symlinks", async () => {
    const fixture = await makeFixture();
    const empty = join(fixture.parent, "empty");
    await mkdir(empty);
    const ok = await runExport(
      ["export", "agent", "beta", "--out", empty, "--agent-data", fixture.agentData],
    );
    expect(ok.code).toBe(0);

    const leak = join(fixture.parent, "secret-outside.md");
    await writeFile(leak, "outside-secret\n");
    await mkdir(join(fixture.agentData, "agents", "agent-beta", "memory"), { recursive: true });
    await symlink(leak, join(fixture.agentData, "agents", "agent-beta", "memory", "profile.md"));
    const escaped = await runExport(
      [
        "export",
        "agent",
        "beta",
        "--out",
        join(fixture.parent, "escaped"),
        "--agent-data",
        fixture.agentData,
      ],
      ["outside-secret"],
    );
    expect(escaped.code).toBe(EXIT_CODES.export_forbidden);
    expect(errorCode(escaped.stderr)).toBe("export_forbidden");
  });

  test("exports owned files when the canonical root is named sand-data", async () => {
    const fixture = await makeFixture("sand-data");
    const outNamed = join(fixture.parent, "out-sand-data");
    const named = await runExport(
      ["export", "agent", "alpha", "--out", outNamed, "--agent-data", fixture.agentData],
      [GATEWAY_SECRET, PLUGIN_SECRET],
    );
    expect(named.code).toBe(0);
    expect(JSON.parse(await readFile(join(outNamed, "profile.json"), "utf8")).name).toBe("alpha");
    await expect(readFile(join(outNamed, "gateway.json"), "utf8")).rejects.toThrow();
    await expect(readFile(join(outNamed, "store.db"), "utf8")).rejects.toThrow();

    const link = join(fixture.parent, "agent-data");
    await symlink(fixture.agentData, link);
    const outLink = join(fixture.parent, "out-symlink");
    const linked = await runExport(
      ["export", "agent", "alpha", "--out", outLink, "--agent-data", link],
      [GATEWAY_SECRET, PLUGIN_SECRET],
    );
    expect(linked.code).toBe(0);
    expect((parseJson(linked.stdout) as { data: { agentId: string } }).data.agentId).toBe("agent-alpha");

    const inside = await runExport(
      ["export", "agent", "alpha", "--out", join(fixture.agentData, "exported"), "--agent-data", link],
      [GATEWAY_SECRET, PLUGIN_SECRET],
    );
    expect(inside.code).toBe(EXIT_CODES.export_forbidden);
    expect(errorCode(inside.stderr)).toBe("export_forbidden");
  });

  test("does not use Gateway or the live agent-data root", async () => {
    const missingRoot = await runExport(["export", "agent", "alpha", "--out", join(tmpdir(), "unused-out")]);
    expect(missingRoot.code).toBe(EXIT_CODES.export_source_unavailable);
    expect(errorCode(missingRoot.stderr)).toBe("export_source_unavailable");

    const usageResult = await captureCli(["export", "agent", "alpha"], { discoveryPath: "/dev/null" });
    expect(usageResult.code).toBe(2);
    expect(errorCode(usageResult.stderr)).toBe("invalid_usage");
  });
});
