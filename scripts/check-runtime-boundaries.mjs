#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const args = process.argv.slice(2);
const rootIdx = args.indexOf("--root");
const root = resolve(rootIdx >= 0 ? args[rootIdx + 1] : repoRoot);
const json = args.includes("--json");
const failures = [];

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

function rel(path) {
  return relative(root, path).split(sep).join("/");
}

function readJson(path) {
  if (!existsSync(path)) {
    fail("missing package.json", { path: rel(path) });
    return null;
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

const SRC_EXTS = new Set([".ts", ".js", ".cjs", ".mjs", ".mts", ".cts"]);
const kernelRoot = join(root, "packages", "runtime-kernel");
const boxRoot = join(root, "packages", "box-runtime");
const cliRoot = join(root, "packages", "cli");

const requiredSources = [
  "packages/box-runtime/src/preload.ts",
  "packages/box-runtime/src/runtime.ts",
  "packages/runtime-kernel/src/contract.ts",
  "packages/runtime-kernel/src/hash.ts",
  "packages/runtime-kernel/src/selection.ts",
  "packages/runtime-kernel/src/ports.ts",
  "packages/runtime-kernel/src/inference.ts",
  "packages/runtime-kernel/src/commands.ts",
];
for (const path of requiredSources) {
  if (!existsSync(join(root, path))) fail("missing required source", { path });
}

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
for (const path of retired) {
  if (existsSync(join(root, path))) fail("retired POC entry still present", { path });
}

for (const file of walk(join(root, "packages"))) {
  const path = rel(file);
  if (path.includes("/legacy/") || path.includes("/vNext/") || /(^|\/)legacy\//.test(path)) {
    fail("legacy/vNext path present", { path });
  }
  if (path.endsWith("/console.runtime.ts") || path.includes("/src/console/") || path.includes("/internal/console/")) {
    fail("later-only console surface present", { path });
  }
}

const boxPkg = readJson(join(boxRoot, "package.json")) ?? {};
const kernelPkg = readJson(join(kernelRoot, "package.json")) ?? {};
if (JSON.stringify(boxPkg.exports) !== JSON.stringify({ "./runtime": "./src/runtime.ts" })) {
  fail("box-runtime exports must be only ./runtime", { exports: boxPkg.exports });
}
if (boxPkg.exports?.["."]) fail("box-runtime still has root barrel export");

const requiredKernelExports = {
  "./contract": "./src/contract.ts",
  "./hash": "./src/hash.ts",
  "./selection": "./src/selection.ts",
  "./ports": "./src/ports.ts",
  "./status": "./src/status.ts",
  "./monitor": "./src/monitor.ts",
  "./config": "./src/config.ts",
  // Shared payload-free diagnosis consumed by Host, CLI and monitor; it has no
  // IO, execution or provider capability and remains under the import fence.
  "./alerts": "./src/alerts.ts",
  "./observation": "./src/observation.ts",
  "./routines": "./src/routines.ts",
  "./testing": "./src/testing.ts",
  "./inference": "./src/inference.ts",
  "./commands": "./src/commands.ts",
};
const kernelExports = kernelPkg.exports ?? {};
for (const [key, target] of Object.entries(requiredKernelExports)) {
  if (kernelExports[key] !== target) fail("kernel export key/target mismatch", { key, expected: target, actual: kernelExports[key] });
  const file = join(kernelRoot, target);
  if (!existsSync(file)) fail("kernel export target missing", { key, target });
}
if (kernelExports["./contract"] === "./src/ports.ts") fail("kernel contract export must not target ports");
for (const key of Object.keys(kernelExports)) {
  if (!(key in requiredKernelExports)) fail("kernel export not in S2 subpaths", { key });
  if (String(kernelExports[key]).includes("internal")) fail("kernel must not export internal/*", { key });
}

const KERNEL_SUBPATH = {
  "@grokbox/runtime-kernel/contract": "packages/runtime-kernel/src/contract.ts",
  "@grokbox/runtime-kernel/hash": "packages/runtime-kernel/src/hash.ts",
  "@grokbox/runtime-kernel/selection": "packages/runtime-kernel/src/selection.ts",
  "@grokbox/runtime-kernel/ports": "packages/runtime-kernel/src/ports.ts",
  "@grokbox/runtime-kernel/status": "packages/runtime-kernel/src/status.ts",
  "@grokbox/runtime-kernel/monitor": "packages/runtime-kernel/src/monitor.ts",
  "@grokbox/runtime-kernel/config": "packages/runtime-kernel/src/config.ts",
  "@grokbox/runtime-kernel/alerts": "packages/runtime-kernel/src/alerts.ts",
  "@grokbox/runtime-kernel/observation": "packages/runtime-kernel/src/observation.ts",
  "@grokbox/runtime-kernel/routines": "packages/runtime-kernel/src/routines.ts",
  "@grokbox/runtime-kernel/testing": "packages/runtime-kernel/src/testing.ts",
  "@grokbox/runtime-kernel/inference": "packages/runtime-kernel/src/inference.ts",
  "@grokbox/runtime-kernel/commands": "packages/runtime-kernel/src/commands.ts",
};

function layerOf(path) {
  const p = path.split(sep).join("/");
  if (p.startsWith("packages/runtime-kernel/")) return "kernel";
  if (p === "packages/box-runtime/src/preload.ts" || p.includes("/internal/host/")) return "host";
  if (p.includes("/internal/io/")) return "io";
  if (p.includes("/internal/roots/")) return "roots";
  if (p.includes("/internal/process/")) return "process";
  if (p.includes("/internal/wire/")) return "wire";
  if (p.includes("/internal/backends/")) return "backends";
  if (p.includes("/internal/modeld/")) return "modeld";
  if (p.includes("/internal/ops/")) return "ops";
  if (p === "packages/box-runtime/src/runtime.ts") return "runtime";
  if (p.startsWith("packages/cli/")) return "cli";
  if (p.startsWith("packages/box-runtime/src/")) return "box";
  return "other";
}

function resolveSpec(fromFile, spec) {
  if (spec.startsWith("bun:")) return { kind: "bun", path: spec };
  if (spec === "effect" || spec.startsWith("effect/") || spec === "ai" || spec.startsWith("@ai-sdk/")) {
    return { kind: "forbidden-pkg", path: spec };
  }
  if (spec === "@grokbox/box-runtime/runtime") return { kind: "file", path: "packages/box-runtime/src/runtime.ts" };
  if (spec === "@grokbox/box-runtime" || spec === "@grokbox/box-runtime/") {
    return { kind: "file", path: "packages/box-runtime/src/index.ts" };
  }
  if (spec in KERNEL_SUBPATH) return { kind: "file", path: KERNEL_SUBPATH[spec] };
  if (spec.startsWith("@grokbox/runtime-kernel/")) return { kind: "file", path: `packages/runtime-kernel/src/${spec.slice("@grokbox/runtime-kernel/".length)}.ts` };
  if (spec.startsWith("./") || spec.startsWith("../")) {
    const resolved = normalize(join(dirname(join(root, fromFile)), spec));
    return { kind: "file", path: rel(resolved) };
  }
  if (isAbsolute(spec)) return { kind: "file", path: rel(spec) };
  return { kind: "other", path: spec };
}

function collectSpecs(source, scriptKind) {
  const sf = ts.createSourceFile("mod.ts", source, ts.ScriptTarget.Latest, true, scriptKind);
  const specs = [];
  const topLevelWrites = [];
  const bunIdents = [];
  function calleeName(node) {
    if (ts.isIdentifier(node)) return node.text;
    if (ts.isPropertyAccessExpression(node)) {
      const obj = calleeName(node.expression);
      return obj ? `${obj}.${node.name.text}` : node.name.text;
    }
    if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) {
      const obj = calleeName(node.expression);
      return obj ? `${obj}[${JSON.stringify(node.argumentExpression.text)}]` : node.argumentExpression.text;
    }
    return "";
  }
  function visit(node, top) {
    if (ts.isIdentifier(node) && node.text === "Bun") bunIdents.push(true);
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        specs.push(node.moduleSpecifier.text);
      }
    }
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      if (name === "require" || name === "import") {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteral(arg)) specs.push(arg.text);
      }
      if (top && /^(writeFileSync|writeFile|renameSync|mkdirSync|fetch|spawn|spawnSync|exec|execFile|createConnection|createServer|listen|fs\.writeFileSync)$/.test(name)) {
        topLevelWrites.push(name);
      }
    }
    const nextTop = top && (ts.isSourceFile(node) || ts.isIfStatement(node) || ts.isBlock(node) || ts.isExpressionStatement(node) || ts.isVariableStatement(node));
    ts.forEachChild(node, (child) => visit(child, Boolean(nextTop && !ts.isFunctionLike(node) && !ts.isClassDeclaration(node))));
  }
  visit(sf, true);
  return { specs, topLevelWrites, bunIdents, sf };
}

function bunHits(source, bunIdents = []) {
  const hits = [];
  if (/\bbun:/.test(source)) hits.push("bun-scheme");
  if (bunIdents.length) hits.push("Bun.ident");
  return hits;
}

const productionDirs = [join(kernelRoot, "src"), join(boxRoot, "src"), join(cliRoot, "src")];
for (const dir of productionDirs) {
  for (const file of walk(dir)) {
    const ext = extname(file);
    if (!SRC_EXTS.has(ext)) continue;
    const path = rel(file);
    const source = readFileSync(file, "utf8");
    const kind = ext === ".cjs" || ext === ".js" ? ts.ScriptKind.JS : ts.ScriptKind.TS;
    const { specs, topLevelWrites, bunIdents } = collectSpecs(source, kind);
    const fromLayer = layerOf(path);
    if (fromLayer !== "other" && bunHits(source, bunIdents).length) fail("production module uses bun:* or Bun globals", { path });
    if (fromLayer === "host" && topLevelWrites.length) fail("preload/host import-time side effect", { path, topLevelWrites });
    for (const spec of specs) {
      const resolved = resolveSpec(path, spec);
      if (resolved.kind === "bun") fail("production module uses bun:* or Bun globals", { path, spec });
      if (fromLayer === "host" && (resolved.kind === "forbidden-pkg" || spec === "effect")) {
        fail("Host leaf imports Effect/SDK", { path, spec });
      }
      if (fromLayer === "host" && (spec === "acorn" || spec.startsWith("acorn/"))) {
        fail("Host leaf imports parser", { path, spec });
      }
      if (fromLayer === "cli" && resolved.kind === "forbidden-pkg") fail("CLI imported SDK/Effect", { path, spec });
      if (fromLayer === "kernel" && !path.endsWith("/ports.ts") && !path.endsWith("/testing.ts") && !path.endsWith("/inference.ts") && !path.endsWith("/commands.ts") && !path.includes("/internal/testing/") && !path.includes("/internal/inference/") && !path.includes("/internal/commands/") && (spec === "effect" || spec.startsWith("effect/") || resolved.kind === "forbidden-pkg")) {
        fail("kernel non-ports file imports Effect", { path, spec });
      }
      if (fromLayer === "kernel" && spec.startsWith("node:") && !(path.endsWith("src/hash.ts") && spec === "node:crypto")) {
        fail("kernel imported node:* outside hash.ts", { path, spec });
      }
      if (resolved.kind !== "file") continue;
      const to = resolved.path.split(sep).join("/");
      const toLayer = layerOf(to);
      if (fromLayer === "host" && (toLayer === "io" || toLayer === "process" || toLayer === "roots" || toLayer === "runtime" || toLayer === "ops")) {
        fail("forbidden Host import edge", { path, spec, to });
      }
      if (fromLayer === "modeld" && toLayer === "ops") fail("forbidden modeld import of ops", { path, spec, to });
      if (fromLayer === "ops" && (toLayer === "modeld" || toLayer === "roots" || toLayer === "runtime")) {
        fail("forbidden ops import edge", { path, spec, to });
      }
      if (fromLayer === "host" && to === "packages/runtime-kernel/src/ports.ts") {
        fail("Host leaf imports kernel Effect ports", { path, spec });
      }
      if (fromLayer === "io" && toLayer === "roots") fail("forbidden IO import of roots", { path, spec, to });
      if (fromLayer === "kernel" && to.startsWith("packages/box-runtime/")) fail("kernel imported box-runtime", { path, spec, to });
      if (fromLayer === "cli" && to.includes("packages/box-runtime/src/internal/")) {
        fail("CLI imported box-runtime internals", { path, spec, to });
      }
      if (fromLayer === "cli" && (spec === "@grokbox/box-runtime" || spec === "@grokbox/box-runtime/")) {
        fail("CLI imported removed box-runtime root barrel", { path, spec });
      }
    }
  }
}

const preload = join(boxRoot, "src", "preload.ts");
if (existsSync(preload)) {
  const esbuild = join(repoRoot, "node_modules", ".bin", "esbuild");
  if (!existsSync(esbuild)) fail("missing esbuild evidence");
  else {
    const dir = mkdtempSync(join(tmpdir(), "t20-preload-"));
    const outfile = join(dir, "preload.cjs");
    const metafile = join(dir, "meta.json");
    const ran = spawnSync(esbuild, [preload, "--bundle", "--platform=node", "--format=cjs", `--outfile=${outfile}`, `--metafile=${metafile}`], {
      cwd: root,
      encoding: "utf8",
    });
    if (ran.status !== 0) fail("preload esbuild failed", { stderr: (ran.stderr ?? "").slice(0, 500) });
    else {
      const bundle = readFileSync(outfile, "utf8");
      if (/\bfrom ["']effect["']/.test(bundle) || bundle.includes("@ai-sdk/") || /\bfrom ["']ai["']/.test(bundle)) {
        fail("preload bundle contributes Effect/SDK");
      }
      if (/\bacorn\b/.test(bundle) || bundle.includes("shape-worker") || bundle.includes("shape-acorn")) {
        fail("preload bundle contributes parser/ops shape worker");
      }
      if (bunHits(bundle).length) fail("preload bundle uses bun APIs");
      try {
        const meta = JSON.parse(readFileSync(metafile, "utf8"));
        for (const input of Object.keys(meta.inputs ?? {})) {
          if (input.includes("node_modules/effect") || input.includes("node_modules/ai") || input.includes("@ai-sdk")) {
            fail("preload metafile includes Effect/SDK", { input });
          }
          if (input.includes("acorn") || input.includes("host-seam/shape") || input.includes("shape-worker") || input.includes("shape-acorn")) {
            fail("preload metafile includes parser/ops shape worker", { input });
          }
        }
      } catch {
        fail("preload metafile unreadable");
      }
      const trap = spawnSync(process.execPath, ["-e", `
        const fs = require("node:fs");
        const fsp = require("node:fs/promises");
        const writes = [];
        const record = (name, args) => { writes.push({ name, path: String(args[0] ?? "") }); };
        for (const name of ["writeFileSync", "writeFile", "mkdirSync", "renameSync", "appendFileSync", "appendFile", "copyFileSync", "copyFile"]) {
          if (typeof fs[name] === "function") fs[name] = (...args) => { record("fs." + name, args); };
        }
        for (const name of ["writeFile", "appendFile", "mkdir", "rename", "copyFile"]) {
          if (typeof fsp[name] === "function") fsp[name] = (...args) => { record("fs.promises." + name, args); return Promise.resolve(); };
        }
        require(${JSON.stringify(outfile)});
        setImmediate(() => { process.stdout.write(JSON.stringify({ imported: true, writes })); });
      `], { encoding: "utf8", timeout: 5000 });
      if (trap.error) {
        fail("preload import-time trap failed", { error: String(trap.error.message ?? trap.error) });
      } else if (trap.status !== 0) {
        fail("preload import-time proof failed", { status: trap.status, stderr: (trap.stderr ?? "").slice(0, 500) });
      } else if (!trap.stdout || !String(trap.stdout).trim()) {
        fail("preload import-time proof missing");
      } else {
        let trapResult;
        try { trapResult = JSON.parse(trap.stdout); } catch { trapResult = null; }
        if (!trapResult || trapResult.imported !== true || !Array.isArray(trapResult.writes)) {
          fail("preload import-time trap unreadable");
        } else if (trapResult.writes.length > 0) {
          fail("preload import-time side effect", { writes: trapResult.writes });
        }
      }
    }
  }
}

const result = { ok: failures.length === 0, failures, root };
if (json) console.log(JSON.stringify(result, null, 2));
else if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f.message}${f.path ? ` (${f.path})` : ""}`);
} else console.log("runtime boundaries ok");
process.exit(failures.length ? 1 : 0);
