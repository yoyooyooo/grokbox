import { homedir } from "node:os";
import { join } from "node:path";

/** Box-runtime live state. Explicit override is tests/composition only; never XDG. */
export function ephemeralRuntimeRoot(override?: string): string {
  if (override) return override;
  return join(homedir(), ".grokbox", "run");
}
