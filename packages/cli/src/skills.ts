import { join } from "node:path";
import type { CliDeps } from "./deps.ts";
import { usage } from "./errors.ts";
import { formatTable, writeSuccess } from "./output.ts";
import { ioFromOpts, rejectTable } from "./opts.ts";
import { renderCommandReference } from "./registry.ts";

export const CORE_SKILL_NAME = "core";
export const GROKBOX_SKILL_NAME = "grokbox";

type BundledSkill = {
  name: string;
  summary: string;
  fullAvailable: true;
  load: (deps: CliDeps, full: boolean) => Promise<string>;
};

async function readSkillFile(deps: CliDeps, relative: string): Promise<string> {
  return (await deps.readFile(join(deps.skillsDir, relative))).trimEnd();
}

async function loadCoreMarkdown(deps: CliDeps, full: boolean): Promise<string> {
  const overview = await readSkillFile(deps, "core.md");
  if (!full) return `${overview}\n`;
  return `${overview}\n\n${renderCommandReference(deps.cliVersion)}`;
}

async function loadGrokboxMarkdown(deps: CliDeps, full: boolean): Promise<string> {
  const entry = await readSkillFile(deps, join("grokbox", "SKILL.md"));
  if (!full) return `${entry}\n`;
  const extras = ["ownership.md", "models.md", "label.md", "troubleshoot.md"];
  const parts = [entry];
  for (const extra of extras) {
    parts.push(`# ${extra.replace(/\.md$/, "")}\n\n${await readSkillFile(deps, join("grokbox", extra))}`);
  }
  return `${parts.join("\n\n")}\n`;
}

const BUNDLED_SKILLS: readonly BundledSkill[] = [
  {
    name: CORE_SKILL_NAME,
    summary: "Full grokbox CLI inventory (version-matched).",
    fullAvailable: true,
    load: loadCoreMarkdown,
  },
  {
    name: GROKBOX_SKILL_NAME,
    summary: "Turn grokbox on or off, assign a custom model, titles, and desktops.",
    fullAvailable: true,
    load: loadGrokboxMarkdown,
  },
];

function bundledNames(): string {
  return BUNDLED_SKILLS.map((skill) => skill.name).join(", ");
}

function findSkill(name: string): BundledSkill {
  const skill = BUNDLED_SKILLS.find((item) => item.name === name);
  if (!skill) throw usage(`Unknown skill '${name}'. Bundled: ${bundledNames()}.`);
  return skill;
}

export async function runSkillsList(
  deps: CliDeps,
  raw: { json?: boolean; table?: boolean; timeoutMs?: string },
): Promise<void> {
  const io = ioFromOpts(raw);
  const data = {
    cliVersion: deps.cliVersion,
    skills: BUNDLED_SKILLS.map((skill) => ({
      name: skill.name,
      summary: skill.summary,
      fullAvailable: skill.fullAvailable,
    })),
  };
  if (io.table) {
    deps.stdout.write(
      formatTable(
        data.skills.map((skill) => ({
          name: skill.name,
          summary: skill.summary,
          full: skill.fullAvailable ? "yes" : "no",
        })),
      ),
    );
    return;
  }
  writeSuccess(deps.stdout, data);
}

export async function runSkillsGet(
  deps: CliDeps,
  name: string,
  raw: { full?: boolean; json?: boolean; table?: boolean; timeoutMs?: string },
): Promise<void> {
  const io = ioFromOpts(raw);
  rejectTable(io.table, false);
  const query = name.trim();
  if (query.length === 0) throw usage(`Skill name is required. Bundled: ${bundledNames()}.`);
  const skill = findSkill(query);
  const content = await skill.load(deps, Boolean(raw.full));
  if (io.json) {
    writeSuccess(deps.stdout, { name: skill.name, cliVersion: deps.cliVersion, content });
    return;
  }
  deps.stdout.write(content.endsWith("\n") ? content : `${content}\n`);
}
