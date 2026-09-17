import { dataProperty as own, sdkPath, type SdkValidationObservation } from "@grokbox/runtime-kernel/contract";

/** Traverse a bounded Zod issue tree, not an Error message or stack. Union
 * alternatives may explain different schema branches; retain the literal path. */
export function sdkValidationObservation(error: unknown): SdkValidationObservation | undefined {
  const name = own(error, "name");
  if (name !== "AI_TypeValidationError" && name !== "AI_JSONParseError") return undefined;
  const out: SdkValidationObservation = { kind: name === "AI_JSONParseError" ? "json" : "schema", issues: [] };
  const value = own(error, "value");
  let nodes = 0;
  const visit = (issues: unknown, depth: number): void => {
    if (!Array.isArray(issues) || depth > 4) return;
    for (let i = 0; i < Math.min(issues.length, 16) && nodes++ < 64 && out.issues.length < 8; i++) {
      const issue = own(issues, i), nested = own(issue, "errors");
      if (Array.isArray(nested)) { for (let j = 0; j < Math.min(nested.length, 4); j++) visit(own(nested, j), depth + 1); continue; }
      const path = sdkPath(own(issue, "path"));
      if (!path) continue;
      let received = value;
      for (const key of path) received = own(received, key);
      const shape = received === undefined ? "missing" : received === null ? "null" : received === "" ? "empty_string"
        : typeof received === "string" ? "string" : typeof received === "number" ? "number" : typeof received === "boolean" ? "boolean"
        : Array.isArray(received) ? "array" : typeof received === "object" ? "object" : "other";
      const code = own(issue, "code");
      out.issues.push({ path, code: code === "invalid_type" || code === "invalid_value" || code === "too_big" || code === "too_small" ? code : "other", received: shape });
    }
  };
  visit(own(own(error, "cause"), "issues"), 0);
  return out;
}
