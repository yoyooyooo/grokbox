import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const hook = join(import.meta.dir, "..", "scripts", "notify-macos-via-ssh.mjs");
const validNotification = {
  version: 1,
  event: "stimulus-started",
  title: "grokbox night experiment started",
  body: "The controlled SSH activity stimulus has started.",
};

async function invoke(value: unknown, controller = "private-controller") {
  const root = await mkdtemp(join(tmpdir(), "grokbox-notify-hook-test-"));
  const binDir = join(root, "bin");
  const marker = join(root, "ssh-argv.json");
  await mkdir(binDir, { recursive: true });
  const fakeSsh = join(binDir, "ssh");
  await writeFile(fakeSsh, `#!/usr/bin/env node
require("node:fs").writeFileSync(process.env.SSH_ARGV_MARKER, JSON.stringify(process.argv.slice(2)));
`, { mode: 0o700 });
  await chmod(fakeSsh, 0o700);
  const child = Bun.spawn([process.execPath, hook], {
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      GROKBOX_SANDBOX_NOTIFICATION_CONTROLLER: controller,
      SSH_ARGV_MARKER: marker,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin.write(`${JSON.stringify(value)}\n`);
  child.stdin.end();
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const argv = await readFile(marker, "utf8").then(JSON.parse).catch(() => null);
  return { code, stdout, stderr, argv };
}

describe("macOS SSH notification hook", () => {
  test("accepts only the fixed stdin projection and invokes strict BatchMode SSH", async () => {
    const result = await invoke(validNotification);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(result.argv).toEqual([
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=5",
      "-o", "ConnectionAttempts=1",
      "-o", "StrictHostKeyChecking=yes",
      "private-controller",
      expect.stringContaining("/usr/bin/osascript -e"),
    ]);
    expect(result.argv.at(-1)).toContain("grokbox night experiment started");
  });

  test("rejects modified text before SSH", async () => {
    const result = await invoke({ ...validNotification, body: "arbitrary text" });
    expect(result.code).toBe(2);
    expect(result.argv).toBeNull();
    expect(result.stderr).toContain("does not match the fixed event projection");
    expect(result.stderr).not.toContain("arbitrary text");
  });

  test("rejects unsafe controller values before SSH", async () => {
    const result = await invoke(validNotification, "controller; command");
    expect(result.code).toBe(2);
    expect(result.argv).toBeNull();
    expect(result.stderr).toContain("safe BatchMode SSH alias");
  });
});
