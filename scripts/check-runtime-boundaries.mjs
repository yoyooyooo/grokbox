#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const rootIdx = args.indexOf("--root");
const root = rootIdx >= 0 ? args[rootIdx + 1] : join(here, "..");
const json = args.includes("--json");

const failures = [];
const notes = [];

function fail(message, extra = {}) {
  failures.push({ message, ...extra });
}

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === ".git") continue;
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) walk(path, acc);
    else acc.push(path);
  }
  return acc;
}

function read(path) {
  return readFileSync(path, "utf8");
}

const IMPORT_RE = /\b(?:import|export)\s+(?:type\s+)?(?:[^'"\n]+?\sfrom\s*)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;

function specs(source) {
  const found = [];
  for (const match of source.matchAll(IMPORT_RE)) {
    found.push(match[1] ?? match[2] ?? match[3]);
  }
  return found;
}

const kernelRoot = join(root, "packages", "runtime-kernel");
const boxRoot = join(root, "packages", "box-runtime");
const cliRoot = join(root, "packages", "cli");

const retired = [
  "packages/box-runtime/src/index.ts",
  "packages/box-runtime/src/modeld.ts",
  "packages/box-runtime/src/modeld-as1.ts",
  "packages/box-runtime/src/modeld-default.ts",
  "packages/box-runtime/src/modeld-openai.ts",
  "packages/box-runtime/src/modeld-openai-map.ts",
  "packages/box-runtime/src/seam.ts",
  "packages/box-runtime/src/modeld-ipc.ts",
  "packages/box-runtime/src/modeld-serve.ts",
  "packages/box-runtime/src/provider-overflow.ts",
];
for (const rel of retired) {
  if (existsSync(join(root, rel))) fail("retired POC entry still present", { path: rel });
}

if (existsSync(join(boxRoot, "src", "internal", "console")) || existsSync(join(boxRoot, "src", "console"))) {
  fail("T20 must not create console/", { path: "packages/box-runtime/src/console" });
}

function readJson(path) {
  if (!existsSync(path)) {
    fail("missing package.json", { path: relative(root, path) });
    return {};
  }
  return JSON.parse(read(path));
}
const boxPkg = readJson(join(boxRoot, "package.json"));
const kernelPkg = readJson(join(kernelRoot, "package.json"));
if (JSON.stringify(boxPkg.exports) !== JSON.stringify({ "./runtime": "./src/runtime.ts" })) {
  fail("box-runtime exports must be only ./runtime", { exports: boxPkg.exports });
}
if (boxPkg.exports?.["."]) fail("box-runtime still has root barrel export");
const kernelExports = kernelPkg.exports ?? {};
const allowedKernel = ["./contract", "./hash", "./selection", "./ports"];
for (const key of Object.keys(kernelExports)) {
  if (!allowedKernel.includes(key)) fail("kernel export not in S2 subpaths", { key });
}
if (kernelExports["."] || kernelExports["./*"] || Object.keys(kernelExports).some((k) => k.includes("internal"))) {
  fail("kernel must not export root barrel or internal/*");
}

const bunApi = /from\s+["']bun:[^"']+["']|require\s*\(\s*["']bun:[^"']+["']|import\s*\(\s*["']bun:[^"']+["']\)|\bBun\.(file|serve|spawn|write|which)\b/;
const productionGlobs = [
  join(kernelRoot, "src"),
  join(boxRoot, "src"),
  join(cliRoot, "src"),
];
for (const dir of productionGlobs) {
  for (const file of walk(dir).filter((p) => p.endsWith(".ts") || p.endsWith(".js") || p.endsWith(".cjs") || p.endsWith(".mjs"))) {
    const rel = relative(root, file);
    const source = read(file);
    if (bunApi.test(source)) fail("production module uses bun:* or Bun globals", { path: rel });
  }
}

const hostFiles = walk(join(boxRoot, "src", "internal", "host")).concat([join(boxRoot, "src", "preload.ts")]);
const hostForbidden = /from\s+["']effect["']|from\s+["']ai["']|from\s+["']@ai-sdk\//;
for (const file of hostFiles.filter((p) => existsSync(p) && p.endsWith(".ts"))) {
  const source = read(file);
  const rel = relative(root, file);
  if (hostForbidden.test(source)) fail("Host leaf imports Effect/SDK", { path: rel });
  for (const spec of specs(source)) {
    if (spec === "@grokbox/runtime-kernel/ports" || spec.endsWith("/ports")) {
      fail("Host leaf imports kernel Effect ports", { path: rel, spec });
    }
    if (spec.includes("/runtime.ts") || spec === "@grokbox/box-runtime/runtime") {
      fail("preload/host must not import runtime facade", { path: rel, spec });
    }
  }
}

const preload = join(boxRoot, "src", "preload.ts");
if (existsSync(preload)) {
  for (const spec of specs(read(preload))) {
    if (spec.includes("linux.node") || spec.includes("guardian.node") || spec.includes("/roots/")) {
      fail("preload imports process census or roots", { spec });
    }
  }
}

const contractFiles = walk(join(kernelRoot, "src")).filter((p) => p.endsWith(".ts") && !p.endsWith("ports.ts"));
for (const file of contractFiles) {
  const source = read(file);
  const rel = relative(root, file);
  for (const spec of specs(source)) {
    if (spec === "effect" || spec.startsWith("effect/")) fail("kernel non-ports file imports Effect", { path: rel, spec });
    if (spec.startsWith("node:") && !(rel.endsWith("src/hash.ts") && spec === "node:crypto")) {
      fail("kernel imported node:* outside hash.ts", { path: rel, spec });
    }
    if (spec.startsWith("bun:")) fail("kernel imported bun:*", { path: rel, spec });
  }
}

const runtimeFacade = join(boxRoot, "src", "runtime.ts");
if (existsSync(runtimeFacade)) {
  for (const spec of specs(read(runtimeFacade))) {
    if (spec.includes("preload.ts")) fail("runtime.ts must not import preload.ts", { spec });
  }
}

if (existsSync(join(cliRoot, "src"))) {
  for (const file of walk(join(cliRoot, "src")).filter((p) => p.endsWith(".ts"))) {
    const source = read(file);
    const rel = relative(root, file);
    for (const spec of specs(source)) {
      if (spec === "@grokbox/box-runtime" || spec === "@grokbox/box-runtime/") {
        fail("CLI imported removed box-runtime root barrel", { path: rel, spec });
      }
      if (spec.includes("runtime-kernel/internal") || spec.includes("/internal/")) {
        if (spec.includes("@grokbox/runtime-kernel")) fail("CLI imported kernel internals", { path: rel, spec });
      }
      if (spec === "ai" || spec.startsWith("@ai-sdk/") || spec === "effect") {
        fail("CLI imported SDK/Effect", { path: rel, spec });
      }
    }
  }
}

const flags = ["effectMode", "legacy/", "vNext/", "old || new"];
for (const file of walk(join(boxRoot, "src")).concat(walk(join(kernelRoot, "src"))).filter((p) => p.endsWith(".ts"))) {
  const source = read(file);
  if (source.includes("effectMode")) fail("migration flag effectMode present", { path: relative(root, file) });
}

if (existsSync(preload)) {
  const esbuild = spawnSync("bun", ["x", "esbuild", preload, "--bundle", "--platform=node", "--format=cjs", "--outfile=/tmp/t20-preload-check.cjs", "--metafile=/tmp/t20-preload-meta.json"], {
    cwd: root,
    encoding: "utf8",
  });
  if (esbuild.status !== 0) {
    fail("preload esbuild failed", { stderr: esbuild.stderr?.slice(0, 500) });
  } else {
    const bundle = read("/tmp/t20-preload-check.cjs");
    if (/\bfrom ["']effect["']/.test(bundle) || bundle.includes("@ai-sdk/") || /\bfrom ["']ai["']/.test(bundle)) {
      fail("preload bundle contributes Effect/SDK");
    }
    if (bunApi.test(bundle)) fail("preload bundle uses bun APIs");
    try {
      const meta = JSON.parse(read("/tmp/t20-preload-meta.json"));
      for (const input of Object.keys(meta.inputs ?? {})) {
        if (input.includes("node_modules/effect") || input.includes("node_modules/ai") || input.includes("@ai-sdk")) {
          fail("preload metafile includes Effect/SDK", { input });
        }
      }
    } catch {
      notes.push("preload metafile unreadable");
    }
  }
}

const result = { ok: failures.length === 0, failures, notes, root };
if (json) console.log(JSON.stringify(result, null, 2));
else {
  if (failures.length) {
    for (const f of failures) console.error(`FAIL ${f.message}${f.path ? ` (${f.path})` : ""}`);
  } else console.log("runtime boundaries ok");
}
process.exit(failures.length ? 1 : 0);
