import type { CliDeps } from "../deps.ts";
import { CliError, usage } from "../errors.ts";
import type { GatewayClient } from "../gateway.ts";
import { asString, assertUuidV4 } from "../util.ts";
import { findRosterRow } from "./roster.ts";

export const GROUP_MAX_MEMBERS = 6;

export type RosterAttributes = {
  name?: string;
  description?: string;
  instructions?: string;
  title?: string;
  avatarShape?: string;
  avatarColor?: string;
  notify?: string;
  hidden?: string;
};

export function requiredName(value: string | undefined, option = "--name"): string {
  const name = value?.trim() ?? "";
  if (name.length === 0) throw usage(`${option} must not be empty.`);
  return name;
}

export function descriptionInput(raw: RosterAttributes): string | undefined {
  if (raw.description !== undefined && raw.instructions !== undefined) {
    throw usage("Use only one of --description or --instructions.");
  }
  return raw.description ?? raw.instructions;
}

export function parseToggle(value: string | undefined, option: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "on") return true;
  if (value === "off") return false;
  throw usage(`${option} must be on or off.`);
}

export function createNonce(raw: string | undefined, deps: CliDeps): string {
  return assertUuidV4(raw ?? deps.randomUUID(), "--nonce");
}

export function createProfile(raw: RosterAttributes & { name?: string }): Record<string, unknown> {
  const profile: Record<string, unknown> = {
    name: requiredName(raw.name),
    description: descriptionInput(raw)?.trim() ?? "",
  };
  if (raw.title !== undefined) profile.title = raw.title.trim();
  if (raw.avatarShape !== undefined) profile.avatarShape = raw.avatarShape.trim();
  if (raw.avatarColor !== undefined) profile.avatarColor = raw.avatarColor.trim();
  return profile;
}

export function hasProfilePatch(raw: RosterAttributes): boolean {
  return raw.name !== undefined ||
    raw.description !== undefined ||
    raw.instructions !== undefined ||
    raw.title !== undefined ||
    raw.avatarShape !== undefined ||
    raw.avatarColor !== undefined;
}

export function mergedProfile(
  row: Record<string, unknown>,
  raw: RosterAttributes,
): Record<string, unknown> {
  const description = descriptionInput(raw);
  const profile: Record<string, unknown> = {
    name: raw.name === undefined ? requiredName(asString(row.name), "Existing agent name") : requiredName(raw.name),
    description: description === undefined ? asString(row.description) : description.trim(),
  };
  for (const [wire, source] of [
    ["title", "title"],
    ["avatarShape", "avatarShape"],
    ["avatarColor", "avatarColor"],
  ] as const) {
    const patch = raw[source];
    const existing = row[wire];
    if (patch !== undefined) profile[wire] = patch.trim();
    else if (typeof existing === "string") profile[wire] = existing;
  }
  return profile;
}

export function assertAnyAttribute(raw: RosterAttributes): void {
  if (
    !hasProfilePatch(raw) &&
    raw.notify === undefined &&
    raw.hidden === undefined
  ) {
    throw usage("Provide at least one attribute to update.");
  }
}

export function validateRosterSettings(raw: RosterAttributes): void {
  parseToggle(raw.notify, "--notify");
  parseToggle(raw.hidden, "--hidden");
}

export async function applyRosterSettings(
  client: GatewayClient,
  id: string,
  raw: RosterAttributes,
  timeoutMs: number,
  operationId?: string,
): Promise<void> {
  const notify = parseToggle(raw.notify, "--notify");
  const hidden = parseToggle(raw.hidden, "--hidden");
  if (notify !== undefined) {
    await client.setAgentNotifyOnUpdates({ id, isEnabled: notify }, timeoutMs, operationId);
  }
  if (hidden !== undefined) {
    await client.setAgentHiddenFromSidebar({ id, isHidden: hidden }, timeoutMs, operationId);
  }
}

export function resolveMemberIds(agents: unknown[], targets: readonly string[]): string[] {
  if (targets.length === 0) throw usage("At least one --member is required.");
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const target of targets) {
    const row = findRosterRow(agents, target, ["agent"]);
    const id = asString(row.id);
    if (seen.has(id)) throw usage("Group members must be unique after target resolution.");
    seen.add(id);
    ids.push(id);
  }
  if (ids.length > GROUP_MAX_MEMBERS) {
    throw usage(`A group can contain at most ${GROUP_MAX_MEMBERS} members.`);
  }
  return ids;
}

export async function confirmDeletion(
  deps: CliDeps,
  yes: boolean | undefined,
  kind: "agent" | "group",
  row: Record<string, unknown>,
): Promise<void> {
  if (yes) return;
  if (!deps.stdinIsTTY) {
    throw usage(`Deleting a ${kind} in non-interactive mode requires --yes.`);
  }
  const label = asString(row.name) || asString(row.id);
  if (!await deps.confirm(`Delete ${kind} '${label}' permanently? [y/N] `)) {
    throw new CliError("invalid_usage", "Deletion cancelled.");
  }
}
