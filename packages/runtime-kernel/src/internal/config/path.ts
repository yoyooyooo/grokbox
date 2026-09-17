export type ConfigErrorCode =
  | "config_invalid" | "config_path_invalid" | "config_conflict"
  | "config_scope_required" | "config_scope_unavailable" | "config_layout_conflict"
  | "config_migration_required" | "config_apply_pending" | "config_commit_unknown";

export class ConfigError extends Error {
  constructor(readonly code: ConfigErrorCode, message: string, readonly context?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = "ConfigError";
  }
}

export const CONFIG_MAX_BYTES = 128 * 1024;
export const FORBIDDEN_CONFIG_KEYS = new Set(["__proto__", "prototype", "constructor"]);
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** JSON.parse cannot reject duplicate members. This parser also bounds depth and
 * rejects prototype keys before any object is constructed; errors never echo input. */
export function parseConfigJson(text: string): unknown {
  if (new TextEncoder().encode(text).byteLength > CONFIG_MAX_BYTES) {
    throw new ConfigError("config_invalid", "Configuration exceeds the 128 KiB limit.");
  }
  let offset = 0;
  function fail(): never { throw new ConfigError("config_invalid", "Invalid JSON, duplicate member or unsafe key."); }
  function space() { while (offset < text.length && /[\t\n\r ]/.test(text[offset]!)) offset++; }
  function quoted(): string {
    if (text[offset] !== '"') fail();
    const start = offset++;
    while (offset < text.length) {
      const char = text[offset++]!;
      if (char === '"') {
        try { return JSON.parse(text.slice(start, offset)) as string; } catch { return fail(); }
      }
      if (char === "\\") offset++;
      else if (char.charCodeAt(0) < 32) fail();
    }
    return fail();
  }
  function value(depth: number): unknown {
    if (depth > 40) fail();
    space();
    const char = text[offset];
    if (char === '"') return quoted();
    if (char === "{") {
      offset++; space();
      const result: Record<string, unknown> = {};
      if (text[offset] === "}") { offset++; return result; }
      while (offset < text.length) {
        space();
        const key = quoted();
        if (FORBIDDEN_CONFIG_KEYS.has(key) || Object.hasOwn(result, key)) fail();
        space(); if (text[offset++] !== ":") fail();
        result[key] = value(depth + 1);
        space(); const separator = text[offset++];
        if (separator === "}") return result;
        if (separator !== ",") fail();
      }
      return fail();
    }
    if (char === "[") {
      offset++; space(); const result: unknown[] = [];
      if (text[offset] === "]") { offset++; return result; }
      while (offset < text.length) {
        result.push(value(depth + 1)); space();
        const separator = text[offset++];
        if (separator === "]") return result;
        if (separator !== ",") fail();
      }
      return fail();
    }
    for (const [literal, result] of [["true", true], ["false", false], ["null", null]] as const) {
      if (text.startsWith(literal, offset)) { offset += literal.length; return result; }
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(offset));
    if (!number) return fail();
    offset += number[0].length;
    const result = Number(number[0]);
    if (!Number.isFinite(result)) return fail();
    return result;
  }
  const result = value(0); space(); if (offset !== text.length) fail();
  return result;
}

/** RFC6901 and ordinary dotted keys share a single own-property traversal. */
export function configPathTokens(path: string): string[] {
  if (path === "") return [];
  const tokens = path.startsWith("/")
    ? path.slice(1).split("/").map((part) => {
      if (/~(?![01])/u.test(part)) throw new ConfigError("config_path_invalid", "Invalid JSON Pointer escape.");
      return part.replace(/~1/g, "/").replace(/~0/g, "~");
    })
    : path.split(".");
  if (tokens.length > 24 || tokens.some((key) => !key || key.length > 128 ||
    FORBIDDEN_CONFIG_KEYS.has(key) || /[\u0000-\u001f]/u.test(key))) {
    throw new ConfigError("config_path_invalid", "Invalid configuration path.");
  }
  return tokens;
}
export function configPointer(tokens: readonly string[]): string {
  return tokens.length ? `/${tokens.map((key) => key.replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}` : "";
}
export function getConfigValue(document: unknown, tokens: readonly string[]): unknown {
  let current = document;
  for (const token of tokens) {
    if (!isObject(current) || !Object.hasOwn(current, token)) return undefined;
    current = current[token];
  }
  return current;
}
export function replaceConfigValue(document: unknown, tokens: readonly string[], value: unknown, unset = false): unknown {
  if (!tokens.length) {
    if (unset) throw new ConfigError("config_path_invalid", "Cannot unset the configuration root.");
    return structuredClone(value);
  }
  const root = structuredClone(document);
  if (!isObject(root)) throw new ConfigError("config_invalid", "Configuration must be an object.");
  let parent = root;
  for (const token of tokens.slice(0, -1)) {
    if (!Object.hasOwn(parent, token)) {
      if (unset) return root;
      parent[token] = {};
    }
    if (!isObject(parent[token])) throw new ConfigError("config_path_invalid", "Cannot traverse scalar or array configuration.");
    parent = parent[token];
  }
  const leaf = tokens[tokens.length - 1]!;
  if (unset) delete parent[leaf]; else parent[leaf] = structuredClone(value);
  return root;
}
