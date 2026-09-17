import type { JsonValue, ToolDefinition } from "@grokbox/runtime-kernel/contract";

const object = (value: JsonValue | undefined): Record<string, JsonValue> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
// This is a conservative capability recognizer, not a second JSON Schema
// validator. Unknown constraints must not authorize an execution-control flag.
const annotations = ["title", "description", "default", "examples", "deprecated", "$comment"];
const objectKeys = new Set([...annotations, "$schema", "type", "properties", "required", "additionalProperties", "oneOf", "anyOf"]);
const scalarKeys = new Set([...annotations, "type", "const", "enum"]);
const simple = (schema: Record<string, JsonValue>, keys: ReadonlySet<string>) => Object.keys(schema).every(key => keys.has(key));
function textDiscriminator(schema: Record<string, JsonValue>): "text" | "excluded" | "unknown" {
  const raw = object(object(schema.properties)?.type);
  if (!raw || !simple(raw, scalarKeys)) return "unknown";
  if (raw.type !== undefined && raw.type !== "string") return "excluded";
  if ((raw.const !== undefined && raw.const !== "text") || (Array.isArray(raw.enum) && !raw.enum.includes("text"))) return "excluded";
  return raw.const === "text" || (Array.isArray(raw.enum) && raw.enum.includes("text")) ? "text" : "unknown";
}
/** A model stop without tools is already treated as final text delivery. End the
 * native loop only when this STEP's actual text-tool schema grants that field.
 * Older Host generations keep their original contract, not an invented flag. */
export function declaredTextEndTurn(tool: ToolDefinition): boolean {
  const visit = (raw: JsonValue, depth: number): boolean => {
    if (depth > 4) return false;
    const schema = object(raw);
    if (!schema || !simple(schema, objectKeys) || (schema.type !== undefined && schema.type !== "object")) return false;
    if (textDiscriminator(schema) === "excluded") return false;
    const properties = object(schema.properties), endTurn = object(properties?.end_turn);
    const discriminator = object(properties?.type);
    if (properties?.type !== undefined && (!discriminator || !simple(discriminator, scalarKeys)
      || (discriminator.enum !== undefined && !Array.isArray(discriminator.enum)))) return false;
    const acceptsTrue = endTurn?.type === "boolean" && simple(endTurn, scalarKeys)
      && (endTurn.const === undefined || endTurn.const === true)
      && (endTurn.enum === undefined || (Array.isArray(endTurn.enum) && endTurn.enum.includes(true)));
    if (properties?.end_turn !== undefined && !acceptsTrue) return false;
    if (schema.additionalProperties === false && !properties?.end_turn) return false;
    if (schema.oneOf === undefined && schema.anyOf === undefined) return !!acceptsTrue;
    if (schema.oneOf !== undefined && schema.anyOf !== undefined) return false;
    const variants = schema.oneOf ?? schema.anyOf;
    if (!Array.isArray(variants) || variants.length === 0 || variants.length > 64) return false;
    const candidates = variants.map(object);
    if (candidates.some(candidate => !candidate)) return false;
    const matching = candidates.filter(candidate => textDiscriminator(candidate!) === "text");
    // For oneOf, another unconstrained/text branch could also match the payload.
    // Only a uniquely selected text branch and definitely excluded siblings grant.
    if (schema.oneOf !== undefined && (matching.length !== 1 || candidates.some(candidate => textDiscriminator(candidate!) === "unknown"))) return false;
    return matching.some(candidate => visit(candidate!, depth + 1));
  };
  return visit(tool.inputSchema, 0);
}
