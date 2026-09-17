import type { JsonValue, ToolDefinition } from "@grokbox/runtime-kernel/contract";

const object = (value: JsonValue | undefined): Record<string, JsonValue> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
/** A model stop without tools is already treated as final text delivery. End the
 * native loop only when this STEP's actual text-tool schema grants that field.
 * Older Host generations keep their original contract, not an invented flag. */
export function declaredTextEndTurn(tool: ToolDefinition): boolean {
  const visit = (raw: JsonValue, depth: number): boolean => {
    if (depth > 4) return false;
    const schema = object(raw);
    if (!schema) return false;
    const properties = object(schema.properties), type = object(properties?.type);
    if (type?.const !== undefined && type.const !== "text") return false;
    if (Array.isArray(type?.enum) && !type.enum.includes("text")) return false;
    if (object(properties?.end_turn)?.type === "boolean") return true;
    // Only a branch explicitly selecting text can grant a union-specific field.
    for (const kind of ["oneOf", "anyOf"] as const) {
      const variants = schema[kind];
      if (Array.isArray(variants) && variants.length <= 64) for (const variant of variants) {
        const variantType = object(object(object(variant)?.properties)?.type);
        if ((variantType?.const === "text" || (Array.isArray(variantType?.enum) && variantType.enum.includes("text"))) && visit(variant, depth + 1)) return true;
      }
    }
    return false;
  };
  return visit(tool.inputSchema, 0);
}
