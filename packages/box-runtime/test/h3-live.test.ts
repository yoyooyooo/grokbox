import { describe, expect, test } from "bun:test";
import { decideLivePreflight } from "../src/h3-live.ts";
import { decideH3LaunchStrategy } from "../src/launch-strategy.ts";
import { runLiveIdentityInject } from "../src/live-inject.ts";
import { procEnvHas, readNamedProcEnv } from "../src/live-proc.ts";

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
    ).toEqual({ ok: false, code: "transient-adopt-unwired" });
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

  test("procEnvHas is presence-only for this process", () => {
    expect(procEnvHas(process.pid, "PATH")).toBe(true);
    expect(procEnvHas(process.pid, "GROKBOX_PRELOAD_MODE_NOT_REAL")).toBe(false);
    const named = readNamedProcEnv(process.pid, ["PATH", "GROKBOX_PRELOAD_MODE_NOT_REAL"]);
    expect(named.PATH?.length).toBeGreaterThan(0);
    expect(named.GROKBOX_PRELOAD_MODE_NOT_REAL).toBeUndefined();
  });
});
