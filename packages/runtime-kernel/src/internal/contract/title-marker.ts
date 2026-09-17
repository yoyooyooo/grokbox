import { isReasoningEffort } from "../selection/reasoning.ts";
import type { OwnershipState } from "./ownership.ts";

/** App Label keys grokbox writes. Unknown keys are preserved. */
export const LABEL_OWNER_KEY = "owner";
export const LABEL_MODEL_KEY = "m";
export const TITLE_FENCE = " | ";
export type LabelOwner = "box" | "temporal" | "conflict";
export type LabelFields = {
  owner?: LabelOwner;
  m?: string;
  e?: string;
  extra: Array<readonly [string, string]>;
};
export type ParsedAgentTitle = {
  user: string;
  showing: boolean;
  fields: LabelFields;
  raw: string;
};

const KEY = /^[a-z][a-z0-9_]*$/;
const VALUE = /^[A-Za-z0-9._:/-]+$/;
const PAIR = /^([a-z][a-z0-9_]*)=([A-Za-z0-9._:/-]+)$/;
const OWNERS = new Set<LabelOwner>(["box", "temporal", "conflict"]);

export function isLabelValue(value: string): boolean {
  return VALUE.test(value);
}

export function isLabelOwner(value: unknown): value is LabelOwner {
  return value === "box" || value === "temporal" || value === "conflict";
}

export function labelOwnerFromState(state: OwnershipState): LabelOwner | "leave" {
  if (state === "confirmed_box") return "box";
  if (state === "confirmed_temporal") return "temporal";
  if (state === "conflict") return "conflict";
  return "leave";
}

function parsePairs(raw: string): LabelFields | null {
  if (raw.length === 0) return null;
  const extra: Array<readonly [string, string]> = [];
  let owner: LabelOwner | undefined;
  let m: string | undefined;
  let e: string | undefined;
  for (const part of raw.split(",")) {
    const matched = PAIR.exec(part.trim());
    if (!matched) return null;
    const key = matched[1]!;
    const value = matched[2]!;
    if (key === LABEL_OWNER_KEY) {
      if (!OWNERS.has(value as LabelOwner)) return null;
      owner = value as LabelOwner;
      continue;
    }
    if (key === LABEL_MODEL_KEY) {
      m = value;
      continue;
    }
    if (key === "e") { if (!isReasoningEffort(value)) return null; e = value; continue; }
    extra.push([key, value]);
  }
  if (owner === undefined && m === undefined && extra.length === 0) return null;
  return { ...(owner !== undefined ? { owner } : {}), ...(m !== undefined ? { m } : {}), ...(e !== undefined ? { e } : {}), extra };
}

function migrateLegacy(raw: string): string {
  if (raw === "box" || raw === "[box]") return "owner=box";
  if (raw.startsWith("[box] ")) return raw.slice("[box] ".length).trim();
  return raw;
}

export function formatAgentLabel(fields: LabelFields): string {
  const parts: string[] = [];
  if (fields.owner !== undefined) parts.push(`${LABEL_OWNER_KEY}=${fields.owner}`);
  if (fields.m !== undefined) parts.push(`${LABEL_MODEL_KEY}=${fields.m}`);
  if (fields.e !== undefined && isReasoningEffort(fields.e)) parts.push(`e=${fields.e}`);
  for (const [key, value] of fields.extra) {
    if (!KEY.test(key) || !VALUE.test(value) || key === LABEL_OWNER_KEY || key === LABEL_MODEL_KEY || key === "e") continue;
    parts.push(`${key}=${value}`);
  }
  return parts.join(",");
}

export function formatAgentTitle(user: string, fields: LabelFields | null): string {
  const trailer = fields ? formatAgentLabel(fields) : "";
  const trimmedUser = user.trim();
  if (trailer.length === 0) return trimmedUser;
  if (trimmedUser.length === 0) return trailer;
  return `${trimmedUser}${TITLE_FENCE}${trailer}`;
}

function splitLastTrailer(raw: string): { user: string; fields: LabelFields } | null {
  let from = raw.length;
  while (from > 0) {
    const pipe = raw.lastIndexOf("|", from - 1);
    if (pipe < 0) return null;
    const fields = parsePairs(raw.slice(pipe + 1).trim());
    if (fields) return { user: raw.slice(0, pipe).trimEnd(), fields };
    from = pipe;
  }
  return null;
}

export function parseAgentTitle(title: unknown): ParsedAgentTitle {
  const raw = typeof title === "string" ? title.trim() : "";
  const migrated = migrateLegacy(raw);
  let split = splitLastTrailer(migrated);
  if (!split) {
    const fields = parsePairs(migrated);
    if (fields) return { user: "", showing: true, fields, raw };
    return { user: migrated, showing: false, fields: { extra: [] }, raw };
  }
  let user = split.user;
  const fields = split.fields;
  for (;;) {
    const inner = splitLastTrailer(user);
    if (!inner) break;
    user = inner.user;
  }
  return { user, showing: true, fields, raw };
}

function patchFields(
  base: LabelFields,
  owner: LabelOwner,
  m: string | null | undefined,
  e: string | null | undefined,
): LabelFields {
  const fields: LabelFields = {
    owner,
    extra: [...base.extra],
  };
  if (owner === "temporal" || owner === "conflict") return fields;
  if (m === null) return fields;
  if (typeof m === "string" && VALUE.test(m)) fields.m = m;
  else if (m === undefined && base.m !== undefined) fields.m = base.m;
  if (isReasoningEffort(e)) fields.e = e;
  else if (e === undefined && (m === undefined || m === base.m) && base.e !== undefined) fields.e = base.e;
  return fields;
}

export function composeAgentTitle(
  current: unknown,
  action:
    | { type: "show"; owner: LabelOwner; m?: string | null; e?: string | null }
    | { type: "hide" }
    | { type: "sync"; owner: LabelOwner | "leave"; m?: string | null; e?: string | null }
    | { type: "set-user"; user: string; owner: LabelOwner | "leave"; m?: string | null; e?: string | null },
): { title: string; changed: boolean; showing: boolean; skipped?: "unconfirmed" | "hidden" } {
  const parsed = parseAgentTitle(current);
  if (action.type === "hide") {
    const title = parsed.user;
    return { title, changed: title !== parsed.raw, showing: false };
  }
  if (action.type === "sync") {
    if (!parsed.showing) return { title: parsed.raw, changed: false, showing: false, skipped: "hidden" };
    if (action.owner === "leave") return { title: parsed.raw, changed: false, showing: true, skipped: "unconfirmed" };
    const title = formatAgentTitle(parsed.user, patchFields(parsed.fields, action.owner, action.m, action.e));
    return { title, changed: title !== parsed.raw, showing: true };
  }
  if (action.type === "show") {
    const title = formatAgentTitle(parsed.user, patchFields(parsed.fields, action.owner, action.m, action.e));
    return { title, changed: title !== parsed.raw, showing: true };
  }
  const user = action.user.trim();
  if (!parsed.showing) {
    return { title: user, changed: user !== parsed.raw, showing: false };
  }
  if (action.owner === "leave") {
    const title = formatAgentTitle(user, parsed.fields);
    return { title, changed: title !== parsed.raw, showing: true };
  }
  const title = formatAgentTitle(user, patchFields(parsed.fields, action.owner, action.m, action.e));
  return { title, changed: title !== parsed.raw, showing: true };
}
