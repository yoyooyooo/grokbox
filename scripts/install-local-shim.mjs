#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { chmod, mkdir, open, readFile, rename } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import cliPackage from "../package.json" with { type: "json" };

const marker = "# managed by grokbox scripts/install-local-shim.mjs";
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = join(repoRoot, "packages", "cli", "src", "index.ts");
const configuredBun = process.env.GROKBOX_BUN;
const locatedBun = configuredBun ? { status: 0, stdout: configuredBun }
  : spawnSync("sh", ["-c", "command -v bun"], { encoding: "utf8", timeout: 5000, killSignal: "SIGKILL" });
const bun = configuredBun || locatedBun.stdout.trim();
if ((!configuredBun && locatedBun.status !== 0) || !isAbsolute(bun) || bun.includes("\n")) {
  throw new Error("Cannot install the local shim without an absolute Bun executable path.");
}
const targetDir = process.env.GROKBOX_SHIM_DIR || join(homedir(), ".local", "bin");

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

const content = `#!/bin/sh\n${marker}\nset -eu\nrepo=${shellQuote(repoRoot)}\nbun=${shellQuote(bun)}\nif [ ! -f "$repo/packages/cli/src/index.ts" ] || [ ! -f "$repo/scripts/source-cli.ts" ]; then\n  printf '%s\\n' 'grokbox local shim: source checkout is unavailable' >&2\n  exit 127\nfi\ncaller_cwd="$PWD"\nexec "$bun" run --no-env-file --cwd "$repo" "$repo/scripts/source-cli.ts" "$caller_cwd" "$@"\n`;
const legacyContent = `#!/bin/sh\nexec ${bun} ${entry} "$@"\n`;

async function inspect(name) {
  const target = join(targetDir, name);
  let current = null;
  try {
    current = await readFile(target, "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (current !== null && current !== content && current !== legacyContent && !current.includes(marker)) {
    throw new Error(`Refusing to replace unmanaged command: ${target}`);
  }
  return { target, current };
}

async function install(plan) {
  if (plan.current === content) {
    await chmod(plan.target, 0o755);
    return plan.target;
  }

  const temporary = `${plan.target}.tmp-${process.pid}`;
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o755);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, plan.target);
  await chmod(plan.target, 0o755);
  return plan.target;
}

await mkdir(targetDir, { recursive: true, mode: 0o755 });
const plans = await Promise.all([inspect("grokbox"), inspect("gbox")]);
const targets = [];
for (const plan of plans) targets.push(await install(plan));
for (const target of targets) {
  const probe = spawnSync(target, ["--version"], {
    cwd: tmpdir(),
    encoding: "utf8",
    env: process.env, timeout: 10000, killSignal: "SIGKILL", maxBuffer: 64 * 1024,
  });
  if (probe.error || probe.signal || probe.status !== 0 || probe.stdout.trim() !== cliPackage.version) {
    // Do not echo child output or environment: even a broken runtime can print
    // credentials. These finite fields distinguish the original failure cause.
    const code = ["ETIMEDOUT", "ENOENT", "EACCES", "ENOBUFS"].includes(probe.error?.code)
      ? probe.error.code : probe.error ? "other" : null;
    const diagnostic = {
      phase: "installed-shim-version", alias: target.endsWith("/gbox") ? "gbox" : "grokbox",
      reason: code === "ETIMEDOUT" ? "timeout" : code ? "spawn-error"
        : probe.signal ? "signal" : probe.status !== 0 ? "nonzero-exit" : "version-mismatch",
      status: Number.isInteger(probe.status) ? probe.status : null,
      signal: typeof probe.signal === "string" && /^SIG[A-Z0-9]+$/.test(probe.signal) ? probe.signal : null,
      errorCode: code, timeoutMs: 10000,
      stdoutBytes: Buffer.byteLength(probe.stdout ?? ""), stderrBytes: Buffer.byteLength(probe.stderr ?? ""),
    };
    throw new Error(`Installed shim verification failed: ${JSON.stringify(diagnostic)}`);
  }
}
process.stdout.write(`Installed source-backed grokbox shims (${cliPackage.version}):\n${targets.join("\n")}\n`);
