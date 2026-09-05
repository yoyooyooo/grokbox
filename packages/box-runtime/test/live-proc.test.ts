import { describe, expect, test } from "bun:test";
import { LIVE_TEMP_SUPERVISOR_NEEDLE, roleOf } from "../src/live-proc.ts";
import type { ProcessIdentity } from "../src/process.ts";

function proc(cmdline: readonly string[], exe = cmdline[0] ?? "/bin/true"): ProcessIdentity {
  return {
    pid: 42,
    uid: 1000,
    start: 1,
    exe,
    cmdline,
    ppid: 1,
    ancestry: [1],
  };
}

describe("roleOf exact argv shapes", () => {
  test("official node argv entries match wrapper/supervisor/host/temp-supervisor", () => {
    expect(roleOf(proc(["/usr/local/bin/supervise-sand-supervisor"]))).toBe("wrapper");
    expect(roleOf(proc(["/exec-daemon/node", "/usr/local/bin/sand-supervisor.mjs"]))).toBe("supervisor");
    expect(roleOf(proc(["/exec-daemon/node", "/home/box/sand-host/host-main.cjs"]))).toBe("host");
    expect(
      roleOf(proc(["/exec-daemon/node", `/tmp/op/${LIVE_TEMP_SUPERVISOR_NEEDLE}`, "/tmp/op/launch-env.json"])),
    ).toBe("temp-supervisor");
  });

  test("bash -c, rg, and node -e mentioning role files are not official roles", () => {
    const needles = [
      "/home/box/sand-host/host-main.cjs",
      "/usr/local/bin/sand-supervisor.mjs",
      "/usr/local/bin/supervise-sand-supervisor",
    ];
    for (const needle of needles) {
      expect(roleOf(proc(["bash", "-c", `node ${needle}`], "/usr/bin/bash"))).toBeNull();
      expect(roleOf(proc(["rg", needle], "/usr/bin/rg"))).toBeNull();
      expect(roleOf(proc(["node", "-e", `console.log(${JSON.stringify(needle)})`], "/usr/bin/node"))).toBeNull();
    }
  });
});
