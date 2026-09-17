/** Structural SDK rejection evidence only; no error messages, provider values,
 * schema descriptions, prompts or tool arguments are copied. */
export const SDK_VALIDATION_TOKENS = ["choices", "delta", "tool_calls", "function", "type", "id", "index", "name", "arguments", "role", "content", "finish_reason", "usage", "prompt_tokens", "completion_tokens", "total_tokens", "error", "message", "code", "object", "created", "model", "reasoning_content", "reasoning_details"] as const;
export const SDK_VALUE_SHAPES = ["missing", "null", "empty_string", "string", "number", "boolean", "array", "object", "other"] as const;
export type SdkValidationObservation = { kind: "schema" | "json"; issues: Array<{ path: Array<typeof SDK_VALIDATION_TOKENS[number] | number>; code: "invalid_type" | "invalid_value" | "too_big" | "too_small" | "other"; received: typeof SDK_VALUE_SHAPES[number] }> };
export function dataProperty(value: unknown, key: PropertyKey): unknown {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return undefined;
  const d = Object.getOwnPropertyDescriptor(value, key);
  return d && "value" in d ? d.value : undefined;
}
export function sdkPath(value: unknown): SdkValidationObservation["issues"][number]["path"] | undefined {
  if (!Array.isArray(value) || value.length > 12) return undefined;
  const result: SdkValidationObservation["issues"][number]["path"] = [];
  for (let i = 0; i < value.length; i++) {
    const key = dataProperty(value, i);
    if (typeof key === "number" && Number.isSafeInteger(key) && key >= 0 && key <= 128) result.push(key);
    else if (typeof key === "string" && SDK_VALIDATION_TOKENS.includes(key as typeof SDK_VALIDATION_TOKENS[number])) result.push(key as typeof SDK_VALIDATION_TOKENS[number]);
    else return undefined;
  }
  return result;
}
export function projectSdkValidation(value: unknown): SdkValidationObservation | undefined {
  try {
    const kind = dataProperty(value, "kind"), issues = dataProperty(value, "issues");
    if ((kind !== "schema" && kind !== "json") || !Array.isArray(issues)) return undefined;
    const out: SdkValidationObservation = { kind, issues: [] };
    for (let i = 0; i < Math.min(issues.length, 8); i++) {
      const issue = dataProperty(issues, i), path = sdkPath(dataProperty(issue, "path"));
      const code = dataProperty(issue, "code"), received = dataProperty(issue, "received");
      if (!path || typeof code !== "string" || !["invalid_type", "invalid_value", "too_big", "too_small", "other"].includes(code)
        || typeof received !== "string" || !SDK_VALUE_SHAPES.includes(received as typeof SDK_VALUE_SHAPES[number])) continue;
      out.issues.push({ path, code: code as SdkValidationObservation["issues"][number]["code"], received: received as typeof SDK_VALUE_SHAPES[number] });
    }
    return out;
  } catch { return undefined; }
}
