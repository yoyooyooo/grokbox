import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");
const depsPath = join(repoRoot, "src", "deps.ts");
const nodeBin = Bun.which("node");

async function nodeVersion(): Promise<string | null> {
  if (!nodeBin) return null;
  const child = Bun.spawn([nodeBin, "--version"], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(child.stdout).text();
  await child.exited;
  return out.trim();
}

async function text(stream: ReadableStream<Uint8Array>): Promise<string> {
  return await new Response(stream).text();
}

async function runNodeConfirm(
  scriptPath: string,
  mode: string,
  stdin: "ignore" | string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(
    [nodeBin!, "--experimental-strip-types", scriptPath, mode],
    { cwd: repoRoot, stdout: "pipe", stderr: "pipe", stdin: stdin === "ignore" ? "ignore" : "pipe" },
  );
  if (stdin !== "ignore") {
    const sink = child.stdin;
    if (sink) {
      sink.write(stdin);
      await sink.end();
    }
  }
  const guard = setTimeout(() => child.kill(), 8_000);
  try {
    const [stdout, stderr, code] = await Promise.all([text(child.stdout), text(child.stderr), child.exited]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(guard);
  }
}

const version = await nodeVersion();
const match = version?.match(/^v(\d+)\.(\d+)\./);
const major = match ? Number(match[1]) : 0;
const minor = match ? Number(match[2]) : 0;
const nodeSupportsStripTypes = major > 22 || (major === 22 && minor >= 6);
const nodeAvailable = Boolean(nodeBin) && nodeSupportsStripTypes;
const runTest = nodeAvailable ? test : test.skip;

const scriptPath = await mkdtemp(join(tmpdir(), "grokbox-confirm-abort-"));
await writeFile(
  join(scriptPath, "confirm-runner.ts"),
  `import { createProductionDeps } from ${JSON.stringify(depsPath)};
async function main() {
  const mode = process.argv[2] ?? "abort";
  const terminal = setTimeout(() => { console.log("HANG"); process.exit(2); }, 6_000);
  try {
    let result: boolean;
    if (mode === "abort") {
      const ctrl = new AbortController();
      ctrl.abort();
      result = await createProductionDeps(ctrl.signal).confirm("Delete? [y/N] ");
    } else {
      result = await createProductionDeps().confirm("Delete? [y/N] ");
    }
    console.log("RESULT:" + (result ? "true" : "false"));
  } catch (error) {
    console.log("THREW:" + (error instanceof Error ? error.name : "unknown") + ":" + String(error instanceof Error ? error.message : ""));
    process.exit(1);
  } finally {
    clearTimeout(terminal);
  }
}
main();
`,
);

describe("createProductionDeps confirm abort handling", () => {
  runTest("an already-aborted signal resolves confirm to false without throwing", async () => {
    const result = await runNodeConfirm(join(scriptPath, "confirm-runner.ts"), "abort", "ignore");
    expect(result.code, `stderr=${result.stderr} stdout=${result.stdout}`).toBe(0);
    expect(result.stdout.trim()).toBe("RESULT:false");
    expect(result.stdout).not.toContain("THREW");
  }, 15_000);

  runTest("typed y without a signal resolves to true", async () => {
    const result = await runNodeConfirm(join(scriptPath, "confirm-runner.ts"), "typed", "y\n");
    expect(result.code, `stderr=${result.stderr} stdout=${result.stdout}`).toBe(0);
    expect(result.stdout.trim()).toBe("RESULT:true");
  }, 15_000);

  runTest("typed n without a signal resolves to false", async () => {
    const result = await runNodeConfirm(join(scriptPath, "confirm-runner.ts"), "typed", "n\n");
    expect(result.code, `stderr=${result.stderr} stdout=${result.stdout}`).toBe(0);
    expect(result.stdout.trim()).toBe("RESULT:false");
  }, 15_000);
});
