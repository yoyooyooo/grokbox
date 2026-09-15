import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "./util.ts";

export type BotTemplateRecipe = {
  profile: {
    name: string;
    description: string;
    avatarShape?: string;
    avatarColor?: string;
  };
  memory: Array<{ kind?: "profile" | "log"; createdAt?: string; content: string }>;
  skills: Array<{ name: string; description: string; content: string }>;
  routines: Array<{ name: string; slug: string; description: string; content: string }>;
  plugins: Array<{ pluginId: string; name?: string; description?: string }>;
  gettingStarted?: { skill: string };
};

const SKIP_MEMORY = /^\s*\[(?:episode|note)\]/i;

export function parseRecipeJson(text: string): BotTemplateRecipe {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed) || !isRecord(parsed.profile)) {
    throw new Error("Recipe must include profile.");
  }
  const name = typeof parsed.profile.name === "string" ? parsed.profile.name.trim() : "";
  const description = typeof parsed.profile.description === "string" ? parsed.profile.description.trim() : "";
  if (!name || !description) throw new Error("Recipe profile.name and profile.description are required.");
  return parsed as BotTemplateRecipe;
}

export async function packAgentRecipe(agentDir: string): Promise<BotTemplateRecipe> {
  const profileRaw = JSON.parse(await readFile(join(agentDir, "profile.json"), "utf8")) as unknown;
  const profileRec = isRecord(profileRaw) ? profileRaw : {};
  const name = typeof profileRec.name === "string" ? profileRec.name.trim() : "";
  const description = typeof profileRec.description === "string" && profileRec.description.trim().length > 0
    ? profileRec.description.trim()
    : name;
  if (!name) throw new Error("Agent profile.json is missing name.");
  const recipe: BotTemplateRecipe = {
    profile: {
      name,
      description: description.length > 0 ? description : name,
      ...(typeof profileRec.avatarShape === "string" ? { avatarShape: profileRec.avatarShape } : {}),
      ...(typeof profileRec.avatarColor === "string" ? { avatarColor: profileRec.avatarColor } : {}),
    },
    memory: await readMemoryFacts(join(agentDir, "memory")),
    skills: await readSkillProse(join(agentDir, "skills")),
    routines: [],
    plugins: [],
  };
  return recipe;
}

async function readMemoryFacts(memoryDir: string): Promise<BotTemplateRecipe["memory"]> {
  const out: BotTemplateRecipe["memory"] = [];
  try {
    const profile = await readFile(join(memoryDir, "profile.md"), "utf8");
    const content = stripMemory(profile);
    if (content.length > 0) out.push({ kind: "profile", content });
  } catch {
    // optional
  }
  try {
    const logs = (await readdir(join(memoryDir, "log"))).filter((name) => /^\d{4}-\d{2}\.md$/.test(name)).sort();
    for (const file of logs) {
      const raw = await readFile(join(memoryDir, "log", file), "utf8");
      const content = stripMemory(raw);
      if (content.length > 0) out.push({ kind: "log", createdAt: file.slice(0, 7), content });
    }
  } catch {
    // optional
  }
  return out;
}

function stripMemory(text: string): string {
  return text
    .split("\n")
    .filter((line) => !SKIP_MEMORY.test(line))
    .join("\n")
    .trim();
}

async function readSkillProse(skillsDir: string): Promise<BotTemplateRecipe["skills"]> {
  let entries: string[] = [];
  try {
    entries = await readdir(skillsDir);
  } catch {
    return [];
  }
  const skills: BotTemplateRecipe["skills"] = [];
  for (const slug of entries) {
    try {
      const raw = await readFile(join(skillsDir, slug, "SKILL.md"), "utf8");
      const parsed = parseSkillMarkdown(raw, slug);
      if (parsed) skills.push(parsed);
    } catch {
      continue;
    }
  }
  return skills;
}

function parseSkillMarkdown(raw: string, fallback: string): BotTemplateRecipe["skills"][number] | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  let name = fallback;
  let description = fallback;
  let body = trimmed;
  if (trimmed.startsWith("---")) {
    const close = trimmed.indexOf("\n---", 3);
    if (close > 0) {
      const fm = trimmed.slice(3, close);
      body = trimmed.slice(close + 4).trim();
      const nameMatch = /^name:\s*(.+)$/m.exec(fm);
      const descMatch = /^description:\s*(.+)$/m.exec(fm);
      if (nameMatch) name = nameMatch[1]!.trim().replace(/^["']|["']$/g, "");
      if (descMatch) description = descMatch[1]!.trim().replace(/^["']|["']$/g, "");
    }
  }
  if (body.length === 0) return null;
  return { name, description: description.length > 0 ? description : name, content: body };
}
