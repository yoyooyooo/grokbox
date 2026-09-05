import { describe, expect, test } from "bun:test";
import { armGuardian } from "../src/guardian.ts";
import { runObserveOrIdentityInject } from "../src/inject.ts";
import { signalIfMatch, singleOfficialChain } from "../src/process.ts";
import { FakeProcessTree, hangUntilAbort } from "./fake-tree.ts";

function officialChain(tree: FakeProcessTree) {
  return {
    wrapper: tree.spawn("wrapper"),
    supervisor: tree.spawn("supervisor"),
    host: tree.spawn("host"),
  };
}

describe("crash-safe inject harness", () => {
  test("signals only after identity match including PID reuse", () => {
    const tree = new FakeProcessTree();
    const host = tree.spawn("host");
    expect(signalIfMatch(tree, host, "SIGTERM").ok).toBe(true);
    expect(tree.alive(host.pid)).toBe(false);
    const reused = tree.spawn("host", { pid: host.pid });
    expect(reused.pid).toBe(host.pid);
    expect(reused.start).not.toBe(host.start);
    expect(signalIfMatch(tree, host, "SIGKILL")).toMatchObject({ ok: false, reason: "identity-mismatch" });
    expect(tree.alive(reused.pid)).toBe(true);
    expect(tree.signals.every((row) => row.exe.startsWith("/fake/"))).toBe(true);
  });

  test("guardian CONTs the frozen wrapper after injector death and cannot kill", async () => {
    const tree = new FakeProcessTree();
    const wrapper = tree.spawn("wrapper");
    tree.signal(wrapper, "SIGSTOP");
    expect(tree.stopped(wrapper.pid)).toBe(true);
    const guardian = armGuardian({
      wrapper,
      processes: tree,
      deadlineMs: 5_000,
      now: () => 0,
      wait: hangUntilAbort(),
    });
    expect(guardian).not.toHaveProperty("kill");
    expect(guardian).not.toHaveProperty("start");
    expect(guardian).not.toHaveProperty("retarget");
    guardian.crashInjector();
    expect(tree.stopped(wrapper.pid)).toBe(false);
    expect(tree.signals.filter((row) => row.pid === wrapper.pid).map((row) => row.signal)).toEqual([
      "SIGSTOP",
      "SIGCONT",
    ]);
  });

  test("mid-inject disk SHA change aborts to an unpatched single chain", async () => {
    const tree = new FakeProcessTree();
    const chain = officialChain(tree);
    const disk = { value: "sha-a", sha() { return this.value; } };
    const result = await runObserveOrIdentityInject({
      mode: "identity",
      expectedSha: "sha-a",
      disk: {
        sha: () => {
          if (tree.stopped(chain.wrapper.pid)) disk.value = "sha-b";
          return disk.value;
        },
      },
      processes: tree,
      roles: () => tree.roles(),
      wrapper: chain.wrapper,
      supervisor: chain.supervisor,
      host: chain.host,
      now: () => 0,
      wait: hangUntilAbort(),
      spawnTempSupervisor: () => tree.spawn("temp-supervisor"),
      spawnHost: () => tree.spawn("host"),
      kill: (identity) => tree.kill(identity),
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("disk-sha-changed");
    expect(result.modeldRequired).toBe(false);
    expect(tree.roles().some((row) => row.role === "temp-supervisor")).toBe(false);
    expect(singleOfficialChain(result.census)).toBe(true);
    expect(tree.stopped(chain.wrapper.pid)).toBe(false);
    expect(tree.alive(chain.host.pid)).toBe(true);
  });

  test("successful identity inject has 1+1+1 census without modeld", async () => {
    const tree = new FakeProcessTree();
    const chain = officialChain(tree);
    const result = await runObserveOrIdentityInject({
      mode: "identity",
      expectedSha: "sha-a",
      disk: { sha: () => "sha-a" },
      processes: tree,
      roles: () => tree.roles(),
      wrapper: chain.wrapper,
      supervisor: chain.supervisor,
      host: chain.host,
      now: () => 0,
      wait: hangUntilAbort(),
      spawnTempSupervisor: () => tree.spawn("temp-supervisor"),
      spawnHost: () => tree.spawn("host"),
      kill: (identity) => tree.kill(identity),
    });
    expect(result).toMatchObject({ ok: true, coverage: "attested", modeldRequired: false });
    expect(singleOfficialChain(result.census)).toBe(true);
    expect(result.census).toEqual({
      wrapper: 1,
      supervisor: 1,
      host: 1,
      tempSupervisor: 0,
      guardian: 0,
      extras: 0,
    });
    expect(tree.stopped(chain.wrapper.pid)).toBe(false);
    expect(tree.alive(chain.host.pid)).toBe(false);
    expect(tree.signals.every((row) => row.exe.startsWith("/fake/"))).toBe(true);
  });
});
