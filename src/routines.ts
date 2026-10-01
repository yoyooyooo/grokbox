import { createHash } from "node:crypto";

export const NATIVE_ROUTINE_LIMIT = 100;
export const NATIVE_ROUTINE_MAX_BYTES = 512 * 1024;
export const ROUTINE_PROMPT_MAX_BYTES = 16 * 1024;

export type RoutineTrigger =
  | { type: "webhook" }
  | { type: "cron"; schedule: string }
  | { type: "unsupported" };

export type RoutineView = {
  id: string;
  name: string;
  enabled: boolean;
  trigger: RoutineTrigger;
  revision: string;
  definitionRevision: string;
  mutable: boolean;
  createdAtMs: number | null;
  lastRunAtMs: number | null;
  nextRunAtMs: number | null;
  promptIncluded: false;
  credentialsIncluded: false;
  nativeCompareAndSwap: false;
};

export type RoutineCatalog = {
  schemaVersion: 1;
  agentId: string;
  routines: RoutineView[];
  coverage: {
    kind: "native_returned_window";
    limit: number;
    atLimit: boolean;
    complete: false;
  };
};

export type RoutineDefinition = {
  name: string;
  prompt: string;
  trigger: Exclude<RoutineTrigger, { type: "unsupported" }>;
};

export type RoutineSnapshot = {
  catalog: RoutineCatalog;
  definitionDigests: ReadonlyMap<string, string>;
};

export type RoutineFailure =
  | "invalid_input"
  | "unsupported_shape"
  | "not_found_in_window"
  | "revision_conflict"
  | "unsupported_trigger"
  | "confirmation_required";

export class RoutineError extends Error {
  constructor(readonly reason: RoutineFailure) {
    super(`routine_${reason}`);
    this.name = "RoutineError";
  }
}

const fail = (reason: RoutineFailure = "unsupported_shape"): never => {
  throw new RoutineError(reason);
};

function record(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    return fail();
  }
  return value as Record<string, unknown>;
}

function own(row: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(row, key);
  if (descriptor && !("value" in descriptor)) return fail();
  return descriptor?.value;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function boundedText(value: unknown, limit: number): string {
  if (typeof value !== "string" || value.length > limit || value.includes("\0")) return fail();
  return value;
}

function routineTime(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return fail();
  return value;
}

export function routineAgentId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  ) {
    return fail("invalid_input");
  }
  return value.toLowerCase();
}

export function routineId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    return fail("invalid_input");
  }
  return value;
}

export function routineRevision(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) return fail("invalid_input");
  return value;
}

export function routineOperationId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    return fail("invalid_input");
  }
  return value;
}

export function routineName(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length < 1 ||
    value.length > 64 ||
    /[\x00-\x1f\x7f]/.test(value)
  ) {
    return fail("invalid_input");
  }
  return value;
}

export function routinePrompt(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length < 1 ||
    value.includes("\0") ||
    utf8Bytes(value) > ROUTINE_PROMPT_MAX_BYTES
  ) {
    return fail("invalid_input");
  }
  return value;
}

export function routineTrigger(webhook: unknown, cron: unknown): RoutineDefinition["trigger"] {
  const wantsWebhook = webhook === true;
  const hasCron = cron !== undefined;
  if (wantsWebhook === hasCron) return fail("invalid_input");
  if (wantsWebhook) return { type: "webhook" };
  if (
    typeof cron !== "string" ||
    cron.trim() !== cron ||
    cron.length < 1 ||
    cron.length > 512 ||
    /[\x00-\x1f\x7f]/.test(cron)
  ) {
    return fail("invalid_input");
  }
  return { type: "cron", schedule: cron };
}

export function routineDefinition(input: {
  name: unknown;
  prompt: unknown;
  webhook: unknown;
  cron: unknown;
}): RoutineDefinition {
  return {
    name: routineName(input.name),
    prompt: routinePrompt(input.prompt),
    trigger: routineTrigger(input.webhook, input.cron),
  };
}

export function routineDefinitionDigest(definition: RoutineDefinition, enabled: boolean): string {
  return hash({
    name: definition.name,
    prompt: definition.prompt,
    trigger: definition.trigger,
    isEnabled: enabled,
  });
}

export function nativeRoutineCreateSpec(definition: RoutineDefinition) {
  return {
    name: definition.name,
    prompt: definition.prompt,
    trigger: definition.trigger,
    isEnabled: false as const,
  };
}

export function nativeRoutineUpdateSpec(definition: RoutineDefinition) {
  return {
    name: definition.name,
    prompt: definition.prompt,
    trigger: definition.trigger,
  };
}

export function validateNativeRoutineSpec(
  value: unknown,
  mode: "create" | "update",
): Record<string, unknown> {
  const row = record(value);
  const allowed = mode === "create"
    ? ["name", "prompt", "trigger", "isEnabled"]
    : ["name", "prompt", "trigger"];
  if (
    Object.keys(row).length !== allowed.length ||
    Object.keys(row).some((key) => !allowed.includes(key))
  ) {
    return fail("invalid_input");
  }
  const trigger = record(own(row, "trigger"));
  const type = own(trigger, "type");
  let cron: string | undefined;
  let webhook = false;
  if (type === "webhook" && Object.keys(trigger).length === 1) webhook = true;
  else if (
    type === "cron" &&
    Object.keys(trigger).length === 2 &&
    Object.hasOwn(trigger, "schedule")
  ) {
    cron = own(trigger, "schedule") as string;
  } else {
    return fail("invalid_input");
  }
  const definition = routineDefinition({
    name: own(row, "name"),
    prompt: own(row, "prompt"),
    webhook,
    cron,
  });
  if (mode === "create" && own(row, "isEnabled") !== false) return fail("invalid_input");
  return mode === "create"
    ? nativeRoutineCreateSpec(definition)
    : nativeRoutineUpdateSpec(definition);
}

export function projectNativeRoutines(agentId: string, value: unknown): RoutineSnapshot {
  const id = routineAgentId(agentId);
  if (!Array.isArray(value) || value.length > NATIVE_ROUTINE_LIMIT) return fail();

  let measured = 0;
  const seen = new Set<string>();
  const definitionDigests = new Map<string, string>();
  const routines = value.map((raw): RoutineView => {
    const row = record(raw);
    const rid = routineId(own(row, "id"));
    if (seen.has(rid)) return fail();
    seen.add(rid);

    const name = boundedText(own(row, "name"), 512);
    const prompt = boundedText(own(row, "prompt"), 128 * 1024);
    const enabled = own(row, "isEnabled");
    if (typeof enabled !== "boolean") return fail();

    const nativeTrigger = record(own(row, "trigger"));
    const kind = own(nativeTrigger, "type");
    let trigger: RoutineTrigger = { type: "unsupported" };
    if (kind === "webhook" && Object.keys(nativeTrigger).every((key) => key === "type")) {
      trigger = { type: "webhook" };
    } else if (
      kind === "cron" &&
      Object.keys(nativeTrigger).every((key) => key === "type" || key === "schedule")
    ) {
      trigger = { type: "cron", schedule: boundedText(own(nativeTrigger, "schedule"), 512) };
    }

    const session = own(row, "sessionId");
    if (session !== undefined && session !== null) boundedText(session, 128);
    const createdAtMs = routineTime(own(row, "createdAt"));
    const lastRunAtMs = routineTime(own(row, "lastRunAt"));
    const nextRunAtMs = routineTime(own(row, "nextRunAt"));

    measured += utf8Bytes(name) + utf8Bytes(prompt) + 2048;
    if (measured > NATIVE_ROUTINE_MAX_BYTES) return fail();

    const definitionRevision = hash({
      id: rid,
      name,
      prompt,
      trigger,
      createdAtMs,
      session: session ?? null,
    });
    const revision = hash({ definitionRevision, enabled });
    const mutable =
      trigger.type !== "unsupported" &&
      (session === undefined || session === null || session === "default");

    if (trigger.type !== "unsupported") {
      definitionDigests.set(
        rid,
        routineDefinitionDigest(
          { name, prompt, trigger },
          enabled,
        ),
      );
    }

    return {
      id: rid,
      name,
      enabled,
      trigger,
      revision,
      definitionRevision,
      mutable,
      createdAtMs,
      lastRunAtMs,
      nextRunAtMs,
      promptIncluded: false,
      credentialsIncluded: false,
      nativeCompareAndSwap: false,
    };
  });

  return {
    catalog: {
      schemaVersion: 1,
      agentId: id,
      routines,
      coverage: {
        kind: "native_returned_window",
        limit: NATIVE_ROUTINE_LIMIT,
        atLimit: routines.length === NATIVE_ROUTINE_LIMIT,
        complete: false,
      },
    },
    definitionDigests,
  };
}
