import { expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { CliDeps } from "../packages/cli/src/deps.ts";
import { GROKBOX_SKILL_TOPICS } from "../packages/cli/src/skills.ts";
import recipe from "../scripts/templates/grokbox.recipe.json" with { type: "json" };
import { captureCli } from "./helpers.ts";

const skillsDir = resolve(import.meta.dir, "../skills");
const entryPath = join(skillsDir, "grokbox/SKILL.md");
const markdown = async (path: string) => `${(await readFile(path, "utf8")).trimEnd()}\n`;

function isolatedReads() {
  const reads: string[] = [];
  const effects: string[] = [];
  const deps: Partial<CliDeps> = {
    skillsDir,
    readFile: async (path) => {
      reads.push(path);
      return await readFile(path, "utf8");
    },
    fetch: (async () => {
      effects.push("network");
      throw new Error("Skill reads must not contact a service.");
    }) as unknown as typeof fetch,
    runCommand: async () => {
      effects.push("process");
      throw new Error("Skill reads must not run commands.");
    },
    readStdin: async () => {
      effects.push("stdin");
      throw new Error("Skill reads must not read stdin.");
    },
  };
  return { reads, effects, deps };
}

test("default grokbox skill reads only the small entry and retains universal guardrails", async () => {
  const { reads, effects, deps } = isolatedReads();
  const result = await captureCli(["skills", "get", "grokbox"], deps);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toBe(await markdown(entryPath));
  expect(reads).toEqual([entryPath]);
  expect(effects).toEqual([]);
  // Budgets protect progressive disclosure, not exact prose or line wrapping.
  expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(4096);
  expect(result.stdout.trim().split(/\s+/).length).toBeLessThanOrEqual(600);
  for (const rule of ["Never change your own model", "confirmed_box", "clientNonce", "queued, not a reply", "authorization", "credentials"]) {
    expect(result.stdout).toContain(rule);
  }
  for (const advanced of ["--slice-review", "GROKBOX_RUN_ROOT", "model-dogfood", "runtimeFailure.diagnostic"]) {
    expect(result.stdout).not.toContain(advanced);
  }
});

for (const topic of GROKBOX_SKILL_TOPICS) {
  test(`topic ${topic.name} loads only its companion in markdown and versioned JSON`, async () => {
    for (const json of [false, true]) {
      const { reads, effects, deps } = isolatedReads();
      const args = ["skills", "get", "grokbox", "--topic", topic.name, ...(json ? ["--json"] : [])];
      const result = await captureCli(args, deps);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      const expected = await markdown(join(skillsDir, "grokbox", topic.file));
      if (json) {
        const output = JSON.parse(result.stdout);
        expect(output).toMatchObject({ ok: true, data: { name: "grokbox", topic: topic.name, content: expected } });
        expect(output.data.cliVersion).toBeString();
      } else {
        expect(result.stdout).toBe(expected);
      }
      expect(reads).toEqual([join(skillsDir, "grokbox", topic.file)]);
      expect(effects).toEqual([]);
    }
  });
}

test("full grokbox reference loads every registered topic exactly once, including adopt", async () => {
  const { reads, effects, deps } = isolatedReads();
  const result = await captureCli(["skills", "get", "grokbox", "--full", "--json"], deps);
  expect(result.code, result.stderr).toBe(0);
  const data = JSON.parse(result.stdout).data;
  expect(data.name).toBe("grokbox");
  expect(data.topic).toBeUndefined();
  const paths = [entryPath, ...GROKBOX_SKILL_TOPICS.map((topic) => join(skillsDir, "grokbox", topic.file))];
  const parts = await Promise.all(paths.map(async (path) => (await markdown(path)).trimEnd()));
  expect(data.content).toBe(`${parts.join("\n\n")}\n`);
  expect(data.content).toContain("# Adopt — Host recovery");
  expect(reads).toEqual(paths);
  expect(new Set(reads).size).toBe(paths.length);
  expect(effects).toEqual([]);
});

test("skills list discovers topic levels without reading content or contacting services", async () => {
  const { reads, effects, deps } = isolatedReads();
  const result = await captureCli(["skills", "list", "--json"], deps);
  expect(result.code, result.stderr).toBe(0);
  const data = JSON.parse(result.stdout).data;
  expect(data.skills.find((skill: { name: string }) => skill.name === "grokbox").topics).toEqual(
    GROKBOX_SKILL_TOPICS.map(({ name, level, summary }) => ({ name, level, summary })),
  );
  expect(data.skills.find((skill: { name: string }) => skill.name === "core").topics).toEqual([]);
  const table = await captureCli(["skills", "list", "--table"], deps);
  expect(table.code, table.stderr).toBe(0);
  for (const topic of GROKBOX_SKILL_TOPICS) expect(table.stdout).toContain(topic.name);
  expect(reads).toEqual([]);
  expect(effects).toEqual([]);
});

for (const args of [
  ["grokbox", "--topic", "missing"],
  ["grokbox", "--topic", ""],
  ["grokbox", "--topic", "  "],
  ["grokbox", "--topic", "../core"],
  ["grokbox", "--topic", "/etc/passwd"],
  ["grokbox", "--topic", "adopt.md"],
  ["grokbox", "--topic", "adopt", "--full"],
  ["core", "--topic", "models"],
  ["unknown", "--topic", "models"],
  ["grokbox", "--topic"],
  ["grokbox", "--topic", "send", "--table"],
]) {
  test(`invalid skill selector fails before reading files: ${JSON.stringify(args)}`, async () => {
    const { reads, effects, deps } = isolatedReads();
    const result = await captureCli(["skills", "get", ...args], deps);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, error: { code: "invalid_usage" } });
    expect(reads).toEqual([]);
    expect(effects).toEqual([]);
  });
}

test("topic errors advertise valid names and missing companions fail without partial output", async () => {
  const invalid = await captureCli(["skills", "get", "grokbox", "--topic", "missing"], {});
  for (const topic of GROKBOX_SKILL_TOPICS) expect(invalid.stderr).toContain(topic.name);
  for (const selector of [["--full"], ["--topic", "adopt"]]) {
    const result = await captureCli(["skills", "get", "grokbox", ...selector], {
      skillsDir,
      readFile: async (path) => {
        if (path.endsWith("/adopt.md")) throw new Error("Missing companion fixture");
        return await readFile(path, "utf8");
      },
    });
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toBe("");
  }
});

test("core compatibility and generated help both retain the version-matched selector", async () => {
  for (const full of [false, true]) {
    const result = await captureCli(["skills", "get", "core", ...(full ? ["--full"] : []), "--json"], {});
    expect(result.code, result.stderr).toBe(0);
    const data = JSON.parse(result.stdout).data;
    expect(data).toMatchObject({ name: "core" });
    expect(data.topic).toBeUndefined();
    const overview = await markdown(join(skillsDir, "core.md"));
    if (full) {
      expect(data.content).toStartWith(overview);
      expect(data.content).toContain("--topic <topic>");
    } else {
      expect(data.content).toBe(overview);
    }
  }
  const help = await captureCli(["skills", "get", "--help"], {});
  expect(help.code, help.stderr).toBe(0);
  expect(help.stdout).toContain("--topic <topic>");
  expect(help.stdout).toContain("--full");
});

test("topic manifest, entry routes, and bundled markdown links cannot drift", async () => {
  const names = GROKBOX_SKILL_TOPICS.map((topic) => topic.name);
  const topicFiles = GROKBOX_SKILL_TOPICS.map((topic) => topic.file);
  expect(new Set(names).size).toBe(names.length);
  expect(new Set(topicFiles).size).toBe(topicFiles.length);
  const files = (await readdir(join(skillsDir, "grokbox"))).filter((file) => file.endsWith(".md"));
  expect(files.sort()).toEqual(["SKILL.md", ...topicFiles].sort());
  const entry = await markdown(entryPath);
  for (const topic of GROKBOX_SKILL_TOPICS) expect(entry).toContain(`](${topic.file})`);
  for (const file of files) {
    const path = join(skillsDir, "grokbox", file);
    const content = await markdown(path);
    for (const [, href] of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      if (!href || /^[a-z]+:/i.test(href)) continue;
      const [target, anchor] = href.split("#");
      const targetPath = resolve(dirname(path), target || file);
      expect(targetPath.startsWith(`${skillsDir}/`), `${file}: ${href} must ship in the package`).toBe(true);
      const linked = await markdown(targetPath);
      if (anchor) {
        const headings = [...linked.matchAll(/^#+ (.+)$/gm)].map((match) =>
          match[1]!.toLowerCase().replace(/[^a-z0-9\s-]/g, "").replace(/\s/g, "-"),
        );
        expect(headings, `${file}: ${href}`).toContain(anchor);
      }
    }
  }
});

test("template recipe and stub share one small loader, never embedded recovery steps", async () => {
  const stub = await markdown(join(skillsDir, "stubs/grokbox.md"));
  const body = stub.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
  expect(recipe.skills).toHaveLength(1);
  expect(recipe.skills[0]!.content).toBe(body);
  expect(Buffer.byteLength(body)).toBeLessThanOrEqual(1024);
  expect(body).toContain("grokbox skills get grokbox");
  expect(body).toContain("--topic <name>");
  expect(body).toContain("official brain");
  for (const text of [body, recipe.profile.description]) {
    expect(text).not.toMatch(/--full|--slice-review|--force|runtime profile|host stop/);
  }
});
