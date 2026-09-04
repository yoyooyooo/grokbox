import { join } from "node:path";
import type { CliDeps } from "./deps.ts";
import { usage } from "./errors.ts";
import { formatTable, writeSuccess } from "./output.ts";
import { ioFromOpts, rejectTable } from "./opts.ts";
import { renderCommandReference } from "./registry.ts";

export const CORE_SKILL_NAME = "core";
export const CORE_SKILL_SUMMARY = "Core grokbox usage guide.";

export async function loadCoreMarkdown(deps: CliDeps, full: boolean): Promise<string> {
  const overview = await deps.readFile(join(deps.skillsDir, "core.md"));
  if (!full) return overview.trimEnd() + "\n";
  return `${overview.trimEnd()}\n\n${renderCommandReference(deps.cliVersion)}`;
}

export async function runSkillsList(
  deps: CliDeps,
  raw: { json?: boolean; table?: boolean; timeoutMs?: string },
): Promise<void> {
  const io = ioFromOpts(raw);
  const data = {
    cliVersion: deps.cliVersion,
    skills: [{ name: CORE_SKILL_NAME, summary: CORE_SKILL_SUMMARY, fullAvailable: true }],
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
  if (name !== CORE_SKILL_NAME) throw usage(`Unknown skill '${name}'. v1 only bundles core.`);
  const content = await loadCoreMarkdown(deps, Boolean(raw.full));
  if (io.json) {
    writeSuccess(deps.stdout, { name: CORE_SKILL_NAME, cliVersion: deps.cliVersion, content });
    return;
  }
  deps.stdout.write(content.endsWith("\n") ? content : `${content}\n`);
}
