import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CliDeps } from "./deps.ts";
import { CliError } from "./errors.ts";
import { createCursorChecksum } from "./sandbox/cursor.ts";
import type { BotTemplateRecipe } from "./template-recipe.ts";
import { isRecord } from "./util.ts";

export type StagedTemplate = {
  shareId: string;
  version: number;
  published: boolean;
  shareUrl: string;
};

const DEFAULT_BACKEND = "https://api2.cursor.sh";
const CLIENT_VERSION = "0.49.0-pre.11";
const BOX_NAMESPACE = "prod";

function grokBotTemplateShareUrl(shareId: string): string {
  return `https://x.ai/bot/${shareId}`;
}

function runRoot(deps: CliDeps): string {
  const configured = deps.env.GROKBOX_RUN_ROOT;
  return typeof configured === "string" && configured.length > 0 ? configured : join(homedir(), ".grokbox", "run");
}

async function launchEnv(deps: CliDeps): Promise<Record<string, string>> {
  try {
    const raw = JSON.parse(await readFile(join(runRoot(deps), "state", "launch-env.json"), "utf8")) as unknown;
    if (isRecord(raw) && isRecord(raw.env)) {
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(raw.env)) {
        if (typeof value === "string" && value.length > 0) env[key] = value;
      }
      return env;
    }
  } catch {
    // optional overlay
  }
  return {};
}

async function boxEnv(deps: CliDeps): Promise<Record<string, string>> {
  const overlay = await launchEnv(deps);
  const env: Record<string, string> = { ...overlay };
  for (const [key, value] of Object.entries(deps.env)) {
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }
  return env;
}

export async function stageBotTemplate(
  deps: CliDeps,
  input: { sourceAgentId: string; recipe: BotTemplateRecipe; visibility: "public" | "team" },
): Promise<StagedTemplate> {
  const env = await boxEnv(deps);
  const renewal = env.SAND_INFERENCE_RENEWAL_CREDENTIAL;
  if (!renewal) {
    throw new CliError(
      "runtime_local_only",
      "template stage requires the box-local inference renewal credential (Host launch-env).",
    );
  }
  const backendUrl = new URL(env.SAND_BACKEND_URL || env.CURSOR_API_BASE_URL || DEFAULT_BACKEND).toString();
  const dataRoot = env.SAND_DATA_ROOT || join(homedir(), "sand-data");
  let machineId = "";
  try {
    const secrets = JSON.parse(await readFile(join(dataRoot, "host-secrets.json"), "utf8")) as unknown;
    if (isRecord(secrets) && typeof secrets.machineId === "string") machineId = secrets.machineId;
  } catch {
    machineId = "";
  }
  if (machineId.length === 0) {
    throw new CliError("runtime_local_only", "template stage requires host-secrets machine id.");
  }
  const identity = {
    "x-cursor-client-type": "sand",
    "x-cursor-client-source": "sand-desktop",
    "x-cursor-client-version": CLIENT_VERSION,
    "x-sand-box-namespace": BOX_NAMESPACE,
  };
  const fetchFn = deps.fetch;
  const renewRes = await fetchFn(new URL("/sand-box/inference-credential", backendUrl), {
    method: "POST",
    headers: { "content-type": "application/json", ...identity },
    body: JSON.stringify({ credential: renewal }),
    signal: deps.signal,
  });
  if (!renewRes.ok) {
    throw new CliError("gateway_internal", `template stage renewal failed (${renewRes.status}).`);
  }
  const renewed = await renewRes.json() as unknown;
  const accessToken = isRecord(renewed) && typeof renewed.accessToken === "string" ? renewed.accessToken : "";
  if (accessToken.length === 0) {
    throw new CliError("gateway_internal", "template stage renewal returned no access token.");
  }
  const blob = Buffer.from(JSON.stringify(input.recipe), "utf8");
  const createRes = await fetchFn(new URL("/aiserver.v1.GrokBotService/CreateGrokBotTemplate", backendUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "connect-protocol-version": "1",
      authorization: `Bearer ${accessToken}`,
      "x-cursor-checksum": createCursorChecksum(machineId, deps.now()),
      "x-ghost-mode": "false",
      ...identity,
    },
    body: JSON.stringify({
      name: input.recipe.profile.name,
      avatarShape: input.recipe.profile.avatarShape,
      avatarColor: input.recipe.profile.avatarColor,
      description: input.recipe.profile.description,
      sourceAgentId: input.sourceAgentId,
      requestedVisibility: input.visibility === "team"
        ? "GROK_BOT_TEMPLATE_VISIBILITY_TEAM"
        : "GROK_BOT_TEMPLATE_VISIBILITY_PUBLIC",
      blobContentType: "application/json",
      blobByteSize: String(blob.byteLength),
    }),
    signal: deps.signal,
  });
  const createdText = await createRes.text();
  if (!createRes.ok) {
    throw new CliError("gateway_internal", `template stage create failed (${createRes.status}).`);
  }
  const created = JSON.parse(createdText) as unknown;
  if (!isRecord(created)) throw new CliError("gateway_internal", "template stage create returned a non-object.");
  const template = isRecord(created.template) ? created.template : {};
  const shareId = typeof template.shareId === "string" ? template.shareId : "";
  const version = typeof created.version === "number" ? created.version : Number(created.version);
  const putUrl = typeof created.blobPutUrl === "string" ? created.blobPutUrl : "";
  if (!shareId || !Number.isInteger(version) || version < 1 || putUrl.length === 0) {
    throw new CliError("gateway_internal", "template stage create returned an incomplete receipt.");
  }
  const putRes = await fetchFn(putUrl, {
    method: "PUT",
    headers: { "content-type": "application/json", "content-length": String(blob.byteLength) },
    body: new Uint8Array(blob),
    signal: deps.signal,
  });
  if (!putRes.ok) throw new CliError("gateway_internal", `template stage blob put failed (${putRes.status}).`);
  return {
    shareId,
    version,
    published: template.published === true,
    shareUrl: grokBotTemplateShareUrl(shareId),
  };
}
