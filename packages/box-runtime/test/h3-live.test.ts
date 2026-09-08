import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  decideLivePreflight,
  identityHostReady,
  liveAdoptLaunchSpec,
  liveClassify,
  reviewOfficialAdoptCapability,
} from "../src/internal/process/h3-live.ts";
import { decideH3LaunchStrategy } from "../src/internal/process/launch-strategy.ts";
import { runLiveIdentityInject } from "../src/internal/process/live-inject.ts";
import { LIVE_TEMP_SUPERVISOR_NEEDLE, procEnvHas, readNamedProcEnv } from "../src/internal/process/linux.node.ts";

const ident = {
  pid: 1,
  uid: 1000,
  start: 1,
  exe: "/exec-daemon/node",
  ppid: 2,
  ancestry: [2],
};

describe("live H3 preflight (zero-signal abort)", () => {
  test("duplicate/missing chain, unknown SHA, and launch strategy abort before inject", () => {
    expect(
      decideLivePreflight({
        unique: { ok: false, code: "duplicate-role" },
        reviewed: { ok: true },
        strategy: "direct-overlay",
      }),
    ).toEqual({ ok: false, code: "duplicate-role" });
    expect(
      decideLivePreflight({
        unique: { ok: false, code: "missing-role" },
        reviewed: { ok: true },
        strategy: "direct-overlay",
      }),
    ).toEqual({ ok: false, code: "missing-role" });
    expect(
      decideLivePreflight({
        unique: { ok: true },
        reviewed: { ok: false, code: "unknown-sha" },
        strategy: "direct-overlay",
      }),
    ).toEqual({ ok: false, code: "unknown-sha" });
    expect(
      decideLivePreflight({
        unique: { ok: true },
        reviewed: { ok: true },
        strategy: "unavailable",
      }),
    ).toEqual({ ok: false, code: "launch-strategy-unavailable" });
    expect(
      decideLivePreflight({
        unique: { ok: true },
        reviewed: { ok: true },
        strategy: "transient-adopt-candidate",
      }),
    ).toEqual({ ok: true });
    expect(
      decideLivePreflight({
        unique: { ok: true },
        reviewed: { ok: true },
        strategy: "direct-overlay",
      }),
    ).toEqual({ ok: true });
  });

  test("official sand-supervisor is not direct-overlay", () => {
    expect(
      decideH3LaunchStrategy({
        supervisor: {
          ...ident,
          cmdline: ["/exec-daemon/node", "/usr/local/bin/sand-supervisor.mjs"],
        },
      }),
    ).toBe("unavailable");
    expect(
      decideH3LaunchStrategy({
        supervisor: {
          ...ident,
          cmdline: ["/exec-daemon/node", "/usr/local/bin/sand-supervisor.mjs"],
        },
        reviewedAdoptCapability: true,
      }),
    ).toBe("transient-adopt-candidate");
    expect(
      decideH3LaunchStrategy({
        supervisor: {
          ...ident,
          cmdline: ["/exec-daemon/node", "disposable-supervisor.cjs", "host.cjs", "pid", "launch.json"],
        },
      }),
    ).toBe("direct-overlay");
    expect(
      decideH3LaunchStrategy({
        supervisor: {
          ...ident,
          cmdline: ["/exec-daemon/node", "disposable-adopt-supervisor.cjs", "host.cjs"],
        },
      }),
    ).toBe("transient-adopt-candidate");
  });

  test("runLiveIdentityInject without reviewed profile stays blocked", async () => {
    const result = await runLiveIdentityInject();
    expect(result.ok).toBe(false);
    expect(result.recoveryRequired).toBe(false);
    expect(result.code).toBe("live-host-blocked");
    expect(result.coverage).toBe("none");
  });

  test("temp supervisor is not classified as host; launch spec is allowlisted", () => {
    expect(
      liveClassify({
        ...ident,
        cmdline: ["/exec-daemon/node", `/tmp/op/${LIVE_TEMP_SUPERVISOR_NEEDLE}`, "/tmp/op/launch-env.json"],
      }),
    ).toBe("temp-supervisor");
    expect(
      liveClassify({
        ...ident,
        cmdline: ["/exec-daemon/node", "/home/box/sand-host/host-main.cjs"],
      }),
    ).toBe("host");
    const spec = liveAdoptLaunchSpec(
      { PATH: "/usr/bin", HOME: "/home/box" },
      { execPath: "/exec-daemon/node", hostBundle: "/home/box/sand-host/host-main.cjs", cwd: "/home/box/sand-host" },
    );
    expect(spec.argv).toEqual(["/home/box/sand-host/host-main.cjs"]);
    expect(spec.env.GROKBOX_ALLOW_LIVE_HOST).toBe("1");
    expect(spec.env.ACME_KEY).toBeUndefined();
    const tempSrc = readFileSync(
      fileURLToPath(new URL("../src/grokbox-temp-supervisor.cjs", import.meta.url)),
      "utf8",
    );
    expect(tempSrc).not.toMatch(/SIGKILL/);
    const marker = {
      operationId: "op",
      pid: 9,
      mode: "identity" as const,
      transformed: true as const,
      compiled: true as const,
      modeld: false as const,
    };
    expect(identityHostReady({ marker, gatewayPid: 9, hostPid: 9 })).toBe(true);
    expect(identityHostReady({ marker, gatewayPid: 8, hostPid: 9 })).toBe(false);
    expect(identityHostReady({ marker: null, gatewayPid: 9, hostPid: 9 })).toBe(false);
    expect(
      reviewOfficialAdoptCapability({
        ...ident,
        cmdline: ["/exec-daemon/node", "/tmp/not-a-supervisor.js"],
      }),
    ).toBe(false);
  });

  test("procEnvHas is presence-only for this process", () => {
    expect(procEnvHas(process.pid, "PATH")).toBe(true);
    expect(procEnvHas(process.pid, "GROKBOX_PRELOAD_MODE_NOT_REAL")).toBe(false);
    const named = readNamedProcEnv(process.pid, ["PATH", "GROKBOX_PRELOAD_MODE_NOT_REAL"]);
    expect(named.PATH?.length).toBeGreaterThan(0);
    expect(named.GROKBOX_PRELOAD_MODE_NOT_REAL).toBeUndefined();
  });
});
