import { homedir } from "node:os";
import { join } from "node:path";

export function ephemeralRuntimeRoot(override?: string): string {
  if (override) return override;
  const xdg = process.env.XDG_RUNTIME_DIR;
  return xdg && xdg.length > 0 ? join(xdg, "grokbox") : join(homedir(), ".grokbox", "run");
}
