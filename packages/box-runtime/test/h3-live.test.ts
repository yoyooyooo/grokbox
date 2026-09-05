import { describe, expect, test } from "bun:test";
import { decideLivePreflight, officialSupervisorAcceptsLaunchOverlay } from "../src/h3-live.ts";
import { runLiveIdentityInject } from "../src/live-inject.ts";
import { procEnvHas, readNamedProcEnv } from "../src/live-proc.ts";

describe("live H3 preflight (zero-signal abort)", () => {
  test("duplicate/missing chain, unknown SHA, and unapplicable launch env abort before inject", () => {
    expect(
      decideLivePreflight({
        unique: { ok: false, code: "duplicate-role" },
        reviewed: { ok: true },
        canApplyLaunchEnv: true,
      }),
    ).toEqual({ ok: false, code: "duplicate-role" });
    expect(
      decideLivePreflight({
        unique: { ok: false, code: "missing-role" },
        reviewed: { ok: true },
        canApplyLaunchEnv: true,
      }),
    ).toEqual({ ok: false, code: "missing-role" });
    expect(
      decideLivePreflight({
        unique: { ok: true },
        reviewed: { ok: false, code: "unknown-sha" },
        canApplyLaunchEnv: true,
      }),
    ).toEqual({ ok: false, code: "unknown-sha" });
    expect(
      decideLivePreflight({
        unique: { ok: true },
        reviewed: { ok: true },
        canApplyLaunchEnv: false,
      }),
    ).toEqual({ ok: false, code: "launch-env-unapplicable" });
    expect(
      decideLivePreflight({
        unique: { ok: true },
        reviewed: { ok: true },
        canApplyLaunchEnv: true,
      }),
    ).toEqual({ ok: true });
  });

  test("official sand-supervisor does not accept grokbox launch overlay", () => {
    expect(
      officialSupervisorAcceptsLaunchOverlay({
        pid: 1,
        uid: 1000,
        start: 1,
        exe: "/exec-daemon/node",
        cmdline: ["/exec-daemon/node", "/usr/local/bin/sand-supervisor.mjs"],
        ppid: 2,
        ancestry: [2],
      }),
    ).toBe(false);
    expect(
      officialSupervisorAcceptsLaunchOverlay({
        pid: 1,
        uid: 1000,
        start: 1,
        exe: "/exec-daemon/node",
        cmdline: ["/exec-daemon/node", "disposable-supervisor.cjs", "host.cjs", "pid", "launch.json"],
        ppid: 2,
        ancestry: [2],
      }),
    ).toBe(true);
  });

  test("runLiveIdentityInject without reviewed profile stays blocked", async () => {
    const result = await runLiveIdentityInject();
    expect(result.ok).toBe(false);
    expect(result.recoveryRequired).toBe(false);
    expect(result.code).toBe("live-host-blocked");
    expect(result.coverage).toBe("none");
  });

  test("procEnvHas is presence-only for this process", () => {
    expect(procEnvHas(process.pid, "PATH")).toBe(true);
    expect(procEnvHas(process.pid, "GROKBOX_PRELOAD_MODE_NOT_REAL")).toBe(false);
    const named = readNamedProcEnv(process.pid, ["PATH", "GROKBOX_PRELOAD_MODE_NOT_REAL"]);
    expect(named.PATH?.length).toBeGreaterThan(0);
    expect(named.GROKBOX_PRELOAD_MODE_NOT_REAL).toBeUndefined();
  });
});
