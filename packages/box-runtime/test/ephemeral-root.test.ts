import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ephemeralRuntimeRoot } from "../src/ephemeral.ts";

const XDG_TEST = "/tmp/xdg-runtime-test";
const WORKER = fileURLToPath(new URL("./ephemeral-root-worker.ts", import.meta.url));
const savedHome = process.env.HOME;
const savedXdg = process.env.XDG_RUNTIME_DIR;

afterEach(() => {
  restoreEnv("HOME", savedHome);
  restoreEnv("XDG_RUNTIME_DIR", savedXdg);
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function withEnv<T>(patch: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const previous = Object.fromEntries(Object.keys(patch).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(patch)) restoreEnv(key, value);
    return await fn();
  } finally {
    for (const key of Object.keys(patch)) restoreEnv(key, previous[key]);
  }
}

async function runIsolated(scenario: string): Promise<Record<string, unknown>> {
  const home = await mkdtemp(join(tmpdir(), "grokbox-home-"));
  const xdg = await mkdtemp(join(tmpdir(), "grokbox-xdg-"));
  const proc = Bun.spawn(["bun", WORKER, scenario], {
    cwd: fileURLToPath(new URL("../../..", import.meta.url)),
    env: { ...process.env, HOME: home, XDG_RUNTIME_DIR: xdg },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(exit, stderr).toBe(0);
  return JSON.parse(stdout) as Record<string, unknown>;
}

describe("ephemeralRuntimeRoot pin", () => {
  test("ignores XDG_RUNTIME_DIR=/tmp/xdg-runtime-test and empty/absent XDG", async () => {
    const expected = join(homedir(), ".grokbox", "run");
    await withEnv({ XDG_RUNTIME_DIR: XDG_TEST }, () => {
      expect(ephemeralRuntimeRoot()).toBe(expected);
    });
    await withEnv({ XDG_RUNTIME_DIR: "" }, () => {
      expect(ephemeralRuntimeRoot()).toBe(expected);
    });
    await withEnv({ XDG_RUNTIME_DIR: undefined }, () => {
      expect(ephemeralRuntimeRoot()).toBe(expected);
    });
  });

  test("explicit ephemeralRoot wins exactly regardless of XDG", async () => {
    const override = await mkdtemp(join(tmpdir(), "grokbox-eph-override-"));
    await withEnv({ XDG_RUNTIME_DIR: XDG_TEST }, () => {
      expect(ephemeralRuntimeRoot(override)).toBe(override);
    });
    await withEnv({ XDG_RUNTIME_DIR: undefined }, () => {
      expect(ephemeralRuntimeRoot(override)).toBe(override);
    });
  });
});

describe("default composition uses the home run root", () => {
  test("status reads canonical home attestation and ignores an XDG decoy without writing", async () => {
    const result = await runIsolated("status-canonical");
    expect(result.origin).toBe("grokbox-attested");
    expect(result.reason).toBeNull();
    expect(result.coverage).toBe("attested");
    expect(result.homeUnchanged).toBe(true);
    expect(result.xdgUnchanged).toBe(true);
    expect(result.defaultRoot).toBe(result.runRoot);
    expect(String(result.runRoot)).toContain("/.grokbox/run");
    expect(String(result.runRoot)).not.toBe("/home/box/.grokbox/run");
  });

  test("default watchdog/re-adopt wiring uses home run root; explicit override stays isolated", async () => {
    const result = await runIsolated("watchdog-wiring");
    const first = result.first as { reconcile: string; origin: string };
    const second = result.second as { reconcile: string };
    const homeAtt = result.homeAtt as { coverage: string; diskSha: string; launchMode: string };
    const overrideAtt = result.overrideAtt as { coverage: string; diskSha: string };
    const markerPaths = result.markerPaths as Array<{ markerPath: string; overlayPath: string }>;
    expect(first.reconcile).toBe("converged");
    expect(first.origin).toBe("grokbox-attested");
    expect(homeAtt).toMatchObject({ coverage: "attested", diskSha: "disk-sha-fixture", launchMode: "transient-adopt" });
    expect(result.journalHasAttested).toBe(true);
    expect(result.leasePath).toBe(join(String(result.wiredDefaultRoot), "ops", "coordinator.lock"));
    expect(result.lockPath).toBe(join(String(result.wiredDefaultRoot), "ops", "identity.lock"));
    expect(result.xdgUnchanged).toBe(true);
    expect(second.reconcile).toBe("converged");
    expect(overrideAtt).toMatchObject({ coverage: "attested", diskSha: "disk-sha-fixture" });
    expect(result.homeUnchangedAfterOverride).toBe(true);
    expect(markerPaths[0]).toMatchObject({
      markerPath: join(String(result.wiredDefaultRoot), "state", "preload-marker.json"),
      overlayPath: join(String(result.wiredDefaultRoot), "state", "launch-env.json"),
    });
    expect(markerPaths[1]).toMatchObject({
      markerPath: join(String(result.wiredOverrideRoot), "state", "preload-marker.json"),
      overlayPath: join(String(result.wiredOverrideRoot), "state", "launch-env.json"),
    });
  });

  test("XDG or /tmp decoy alone cannot attest, authorize re-adopt, or copy into the home run root", async () => {
    const result = await runIsolated("no-import");
    const readopt = result.readopt as {
      origin: string;
      reconcile: string;
      signaled: boolean;
      injected: boolean;
    };
    expect(result.origin).toBe("grokbox-unattested");
    expect(result.coverage).toBe("none");
    expect(readopt.origin).toBe("grokbox-unattested");
    expect(readopt.reconcile).toBe("recovery-required");
    expect(readopt.signaled).toBe(false);
    expect(readopt.injected).toBe(false);
    expect(result.homeAtt).toBeNull();
    expect(result.homeUnchangedAfterStatus).toBe(true);
    expect(result.xdgStillThere).toBe(true);
    expect(result.tmpStillThere).toBe(true);
  });
});

describe("live-path source bounds", () => {
  test("resolver and defaulted composition do not mention XDG_RUNTIME_DIR", async () => {
    for (const rel of ["ephemeral.ts", "observe.ts", "attestation.ts", "coordinator.ts", "live-readopt.ts"]) {
      const src = await readFile(new URL(`../src/${rel}`, import.meta.url), "utf8");
      expect(src).not.toContain("XDG_RUNTIME_DIR");
    }
  });
});
