#!/usr/bin/env node
/**
 * Dogfood/install modeld: packed Node dist, not worktree TypeScript.
 *
 * usage: bun run build && bun run modeld:run
 *    or: node dist/index.js runtime modeld run --json
 */
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "dist", "index.js");
if (!existsSync(entry)) {
  process.stderr.write("packaged modeld requires dist/index.js. Next: bun run build\n");
  process.exit(2);
}
const child = spawn(process.execPath, [entry, "runtime", "modeld", "run", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});
const forward = (signal) => {
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
};
process.on("SIGINT", () => forward("SIGINT"));
process.on("SIGTERM", () => forward("SIGTERM"));
child.on("exit", (code, signal) => {
  if (signal) {
    process.exitCode = 1;
    return;
  }
  process.exit(code ?? 1);
});
