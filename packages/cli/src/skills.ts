import { join } from "node:path";
import type { CliDeps } from "./deps.ts";
import { usage } from "./errors.ts";
import { formatTable, writeSuccess } from "./output.ts";
import { ioFromOpts, rejectTable } from "./opts.ts";
import { renderCommandReference } from "./registry.ts";

export const CORE_SKILL_NAME = "core";
export const GROKBOX_SKILL_NAME = "grokbox";

type SkillTopic = {
  name: string;
  file: string;
  level: "task" | "advanced";
  summary: string;
};

// One allowlist owns discovery, selective loading, and the complete reference.
// Never interpret a caller-supplied topic as a filesystem path.
export const GROKBOX_SKILL_TOPICS: readonly SkillTopic[] = [
  { name: "services", file: "services.md", level: "task", summary: "Services, Host channel, and package alignment." },
  { name: "send", file: "send.md", level: "task", summary: "Send once and observe the same reply." },
  { name: "models", file: "models.md", level: "task", summary: "Per-Bot model selection and catalog configuration." },
  { name: "label", file: "label.md", level: "task", summary: "Display-only Bot title trailers." },
  { name: "desktop", file: "desktop.md", level: "task", summary: "Desktop seats and login-fork protection." },
  { name: "templates", file: "templates.md", level: "task", summary: "Template packaging, sharing, and import." },
  { name: "config", file: "config.md", level: "advanced", summary: "Unified configuration, schema-safe edits, migration and commit evidence." },
  { name: "ownership", file: "ownership.md", level: "advanced", summary: "Resolve Server ownership before custom-model use." },
  { name: "troubleshoot", file: "troubleshoot.md", level: "advanced", summary: "Route failures to the smallest safe recovery." },
  { name: "adopt", file: "adopt.md", level: "advanced", summary: "Doctor-directed Host recovery and verified rollback." },
  { name: "diagnostics", file: "diagnostics.md", level: "advanced", summary: "Runtime evidence gaps and request/STEP correlation." },
  { name: "validation", file: "validation.md", level: "advanced", summary: "Deliberate canary and model-switch stay-green checks." },
];

type BundledSkill = {
  name: string;
  summary: string;
  fullAvailable: true;
  topics: readonly SkillTopic[];
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
  const parts = [entry];
  for (const topic of GROKBOX_SKILL_TOPICS) {
    parts.push(await readSkillFile(deps, join("grokbox", topic.file)));
  }
  return `${parts.join("\n\n")}\n`;
}

const BUNDLED_SKILLS: readonly BundledSkill[] = [
  {
    name: CORE_SKILL_NAME,
    summary: "Full grokbox CLI inventory (version-matched).",
    fullAvailable: true,
    topics: [],
    load: loadCoreMarkdown,
  },
  {
    name: GROKBOX_SKILL_NAME,
    summary: "Small operator entry with task-specific and advanced topics.",
    fullAvailable: true,
    topics: GROKBOX_SKILL_TOPICS,
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
      topics: skill.topics.map(({ name, level, summary }) => ({ name, level, summary })),
    })),
  };
  if (io.table) {
    deps.stdout.write(
      formatTable(
        data.skills.map((skill) => ({
          name: skill.name,
          summary: skill.summary,
          full: skill.fullAvailable ? "yes" : "no",
          topics: skill.topics.map((topic) => topic.name).join(", ") || "—",
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
  raw: { full?: boolean; topic?: string; json?: boolean; table?: boolean; timeoutMs?: string },
): Promise<void> {
  const io = ioFromOpts(raw);
  rejectTable(io.table, false);
  const query = name.trim();
  if (query.length === 0) throw usage(`Skill name is required. Bundled: ${bundledNames()}.`);
  const skill = findSkill(query);
  let topic: SkillTopic | undefined;
  if (raw.topic !== undefined) {
    if (raw.full) throw usage("--topic and --full are mutually exclusive.");
    topic = skill.topics.find((item) => item.name === raw.topic!.trim());
    if (!topic) {
      const available = skill.topics.map((item) => item.name).join(", ") || "none (use the entry or --full)";
      throw usage(`Unknown topic '${raw.topic}' for skill '${skill.name}'. Topics: ${available}.`);
    }
  }
  const content = topic
    ? `${await readSkillFile(deps, join(skill.name, topic.file))}\n`
    : await skill.load(deps, Boolean(raw.full));
  if (io.json) {
    writeSuccess(deps.stdout, {
      name: skill.name,
      cliVersion: deps.cliVersion,
      ...(topic ? { topic: topic.name } : {}),
      content,
    });
    return;
  }
  deps.stdout.write(content.endsWith("\n") ? content : `${content}\n`);
}
