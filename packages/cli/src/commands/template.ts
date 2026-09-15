import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { assertBoxLocal, BoxRuntimeError } from "@grokbox/box-runtime/runtime";
import type { CliDeps } from "../deps.ts";
import { CliError, usage } from "../errors.ts";
import { GatewayClient, gatewayMeta } from "../gateway.ts";
import { writeSuccess } from "../output.ts";
import { ioFromOpts } from "../opts.ts";
import { DEFAULT_AGENT_DATA_ROOT } from "../registry.ts";
import { asString, isRecord } from "../util.ts";
import { findRosterRow } from "./roster.ts";
import { packAgentRecipe, parseRecipeJson, type BotTemplateRecipe } from "../template-recipe.ts";
import { stageBotTemplate } from "../template-aiserver.ts";

function agentDataRoot(raw: { agentData?: string }): string {
  return raw.agentData && raw.agentData.length > 0 ? raw.agentData : DEFAULT_AGENT_DATA_ROOT;
}

function visibilityOf(raw: string | undefined): "public" | "team" {
  if (raw === "public" || raw === "team") return raw;
  throw usage("template visibility must be public or team.");
}

function revOf(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw usage("template --rev must be a positive integer.");
  return n;
}

async function resolveAgentId(deps: CliDeps, target: string, timeoutMs: number): Promise<{ id: string; name: string }> {
  const client = new GatewayClient(deps);
  const listed = await client.listAgents(timeoutMs);
  const row = findRosterRow(listed.agents, target, ["agent"]);
  return { id: asString(row.id), name: asString(row.name) };
}

export async function runTemplatePack(
  deps: CliDeps,
  target: string,
  raw: { out?: string; agentData?: string; json?: boolean },
): Promise<void> {
  if (!raw.out) throw usage("template pack requires --out <file>.");
  const agent = await resolveAgentId(deps, target, 10_000);
  const recipe = await packAgentRecipe(join(agentDataRoot(raw), agent.id));
  await mkdir(dirname(raw.out), { recursive: true });
  await writeFile(raw.out, `${JSON.stringify(recipe, null, 2)}\n`, { encoding: "utf8" });
  writeSuccess(deps.stdout, { out: raw.out, profile: recipe.profile.name, skills: recipe.skills.length, memory: recipe.memory.length });
}

async function loadRecipe(deps: CliDeps, target: string, raw: { from?: string; agentData?: string }, timeoutMs: number): Promise<{ id: string; recipe: BotTemplateRecipe }> {
  const agent = await resolveAgentId(deps, target, timeoutMs);
  if (raw.from) {
    return { id: agent.id, recipe: parseRecipeJson(await readFile(raw.from, "utf8")) };
  }
  return { id: agent.id, recipe: await packAgentRecipe(join(agentDataRoot(raw), agent.id)) };
}

export async function runTemplateStage(
  deps: CliDeps,
  target: string,
  raw: { visibility?: string; from?: string; agentData?: string; yes?: boolean; json?: boolean; timeoutMs?: string },
): Promise<void> {
  if (!raw.yes) throw usage("template stage requires --yes.");
  try {
    assertBoxLocal({
      sshHost: deps.sshHost,
      daemonServerUrl: deps.daemonServerUrl,
      transport: deps.transport,
      profileName: deps.profileName,
    });
    const io = ioFromOpts(raw);
    const visibility = visibilityOf(raw.visibility);
    const loaded = await loadRecipe(deps, target, raw, io.timeoutMs);
    const staged = await stageBotTemplate(deps, {
      sourceAgentId: loaded.id,
      recipe: loaded.recipe,
      visibility,
    });
    writeSuccess(deps.stdout, { ...staged, visibility, sourceAgentId: loaded.id });
  } catch (error) {
    if (error instanceof BoxRuntimeError) throw new CliError(error.code, error.message);
    throw error;
  }
}

export async function runTemplatePublish(
  deps: CliDeps,
  shareId: string,
  raw: { rev?: string; yes?: boolean; json?: boolean; timeoutMs?: string },
): Promise<void> {
  if (!raw.yes) throw usage("template publish requires --yes.");
  const io = ioFromOpts(raw);
  const client = new GatewayClient(deps);
  const result = await client.publishBotTemplate({ shareId, version: revOf(raw.rev) }, io.timeoutMs);
  writeSuccess(deps.stdout, result.result, gatewayMeta(result.discovery));
}

export async function runTemplateShow(
  deps: CliDeps,
  shareId: string,
  raw: { rev?: string; json?: boolean; timeoutMs?: string },
): Promise<void> {
  const io = ioFromOpts(raw);
  const client = new GatewayClient(deps);
  const result = await client.getBotTemplateVersion({ shareId, version: revOf(raw.rev) }, io.timeoutMs);
  writeSuccess(deps.stdout, result.result, gatewayMeta(result.discovery));
}

export async function runTemplateVisibility(
  deps: CliDeps,
  shareId: string,
  raw: { visibility?: string; yes?: boolean; json?: boolean; timeoutMs?: string },
): Promise<void> {
  if (!raw.yes) throw usage("template visibility requires --yes.");
  const io = ioFromOpts(raw);
  const client = new GatewayClient(deps);
  const result = await client.setBotTemplateVisibility({ shareId, visibility: visibilityOf(raw.visibility) }, io.timeoutMs);
  writeSuccess(deps.stdout, result.result, gatewayMeta(result.discovery));
}

export async function runTemplateDelete(
  deps: CliDeps,
  shareId: string,
  raw: { yes?: boolean; json?: boolean; timeoutMs?: string },
): Promise<void> {
  if (!raw.yes) throw usage("template delete requires --yes.");
  const io = ioFromOpts(raw);
  const client = new GatewayClient(deps);
  const result = await client.deleteBotTemplate({ shareId }, io.timeoutMs);
  writeSuccess(deps.stdout, result.result ?? { deleted: shareId }, gatewayMeta(result.discovery));
}

export async function runTemplateImport(
  deps: CliDeps,
  shareId: string,
  raw: { name?: string; rev?: string; yes?: boolean; json?: boolean; timeoutMs?: string; avatarShape?: string; avatarColor?: string },
): Promise<void> {
  if (!raw.yes) throw usage("template import requires --yes.");
  if (!raw.name) throw usage("template import requires --name.");
  const io = ioFromOpts(raw);
  const client = new GatewayClient(deps);
  const result = await client.createAgentFromTemplate({
    shareId,
    agentId: randomUUID(),
    name: raw.name,
    avatarShape: raw.avatarShape ?? "wedge",
    avatarColor: raw.avatarColor ?? "violet",
    expectedActiveVersion: revOf(raw.rev),
  }, io.timeoutMs);
  writeSuccess(deps.stdout, result.result, gatewayMeta(result.discovery));
}

export function projectTemplateView(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
