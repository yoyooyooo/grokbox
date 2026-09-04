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
const entry = join(repoRoot, "src", "index.ts");
const locatedBun = spawnSync("sh", ["-c", "command -v bun"], { encoding: "utf8" });
const configuredBun = process.env.GROKBOX_BUN;
const bun = configuredBun || locatedBun.stdout.trim();
if ((!configuredBun && locatedBun.status !== 0) || !isAbsolute(bun) || bun.includes("\n")) {
  throw new Error("Cannot install the local shim without an absolute Bun executable path.");
}
const targetDir = process.env.GROKBOX_SHIM_DIR || join(homedir(), ".local", "bin");

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

const content = `#!/bin/sh\n${marker}\nset -eu\nrepo=${shellQuote(repoRoot)}\nbun=${shellQuote(bun)}\nif [ ! -f "$repo/src/index.ts" ]; then\n  printf '%s\\n' 'grokbox local shim: source checkout is unavailable' >&2\n  exit 127\nfi\nexec "$bun" run "$repo/src/index.ts" "$@"\n`;
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
    env: process.env,
  });
  if (probe.status !== 0 || probe.stdout.trim() !== cliPackage.version) {
    throw new Error(`Installed shim verification failed: ${target}`);
  }
}
process.stdout.write(`Installed source-backed grokbox shims (${cliPackage.version}):\n${targets.join("\n")}\n`);
