import { ConfigError, isObject } from "./path.ts";
import { CONFIG_SCHEMA_VERSION, CONFIG_SCHEMA, validateNode } from "./schema.ts";
import type { DesiredFile } from "../selection/models.ts";

/** Runtime intent is a projection, not another persisted document. Validate only
 * this dependency slice so desktop/client/ops evolution cannot alter TURN pins. */
export function runtimeDesiredFromConfig(value: unknown): DesiredFile {
  if (value === undefined) return { version: 1, mode: "disabled" };
  if (!isObject(value) || value.schemaVersion !== CONFIG_SCHEMA_VERSION) throw new ConfigError("config_migration_required", "Runtime requires the current config schema; run explicit migration first.");
  if (value.runtime === undefined) return { version: 1, mode: "disabled" };
  validateNode(value.runtime, CONFIG_SCHEMA.properties!.runtime!);
  return { version: 1, mode: ((value.runtime as Record<string, unknown>).desiredMode ?? "disabled") as DesiredFile["mode"] };
}
