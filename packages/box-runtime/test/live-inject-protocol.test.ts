import { describe, expect, test } from "bun:test";
import { runIdentityChainInject } from "../src/live-inject.ts";
import { singleOfficialChain } from "../src/process.ts";
import { FakeProcessTree, hangUntilAbort } from "./fake-tree.ts";

function chain(tree: FakeProcessTree) {
  return {
    wrapper: tree.spawn("wrapper"),
    supervisor: tree.spawn("supervisor"),
    host: tree.spawn("host"),
  };
}

describe("identity inject protocol on fake process tree", () => {
  test("STOP wrapper+supervisor, replace host, CONT, census 1+1+1, disk SHA unchanged", async () => {
    const tree = new FakeProcessTree();
    const procs = chain(tree);
    const disk = { sha: "sha-live" };
    const result = await runIdentityChainInject({
      processes: tree,
      wrapper: procs.wrapper,
      supervisor: procs.supervisor,
      host: procs.host,
      diskSha: () => disk.sha,
      roles: () => tree.roles(),
      spawnHost: () => tree.spawn("host"),
      readMarker: () => ({ transformed: true, mode: "identity", modeld: false }),
      wait: hangUntilAbort(),
      now: () => 0,
    });
    expect(result.ok).toBe(true);
    expect(result.coverage).toBe("attested");
    expect(result.recoveryRequired).toBe(false);
    expect(result.diskShaBefore).toBe("sha-live");
    expect(result.diskShaAfter).toBe("sha-live");
    expect(singleOfficialChain(result.census)).toBe(true);
    expect(result.census).toEqual({
      wrapper: 1,
      supervisor: 1,
      host: 1,
      tempSupervisor: 0,
      guardian: 0,
      extras: 0,
    });
    expect(tree.stopped(procs.wrapper.pid)).toBe(false);
    expect(tree.stopped(procs.supervisor.pid)).toBe(false);
    expect(tree.alive(procs.host.pid)).toBe(false);
    const wrapperSignals = tree.signals.filter((row) => row.pid === procs.wrapper.pid).map((row) => row.signal);
    const supervisorSignals = tree.signals.filter((row) => row.pid === procs.supervisor.pid).map((row) => row.signal);
    expect(wrapperSignals[0]).toBe("SIGSTOP");
    expect(wrapperSignals.filter((signal) => signal === "SIGCONT").length).toBeGreaterThanOrEqual(1);
    expect(supervisorSignals[0]).toBe("SIGSTOP");
    expect(supervisorSignals.filter((signal) => signal === "SIGCONT").length).toBeGreaterThanOrEqual(1);
    expect(tree.signals.every((row) => row.exe.startsWith("/fake/"))).toBe(true);
    expect(tree.signals.every((row) => row.pid >= 10_000)).toBe(true);
  });

  test("disk SHA change after STOP aborts, CONTs frozen procs, does not TERM a replacement storm", async () => {
    const tree = new FakeProcessTree();
    const procs = chain(tree);
    const disk = { sha: "sha-a" };
    const result = await runIdentityChainInject({
      processes: tree,
      wrapper: procs.wrapper,
      supervisor: procs.supervisor,
      host: procs.host,
      diskSha: () => (tree.stopped(procs.wrapper.pid) && tree.stopped(procs.supervisor.pid) ? "sha-b" : disk.sha),
      roles: () => tree.roles(),
      spawnHost: () => tree.spawn("host"),
      readMarker: () => ({ transformed: true, mode: "identity", modeld: false }),
      wait: hangUntilAbort(),
      now: () => 0,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("disk-sha-changed");
    expect(tree.alive(procs.host.pid)).toBe(true);
    expect(tree.stopped(procs.wrapper.pid)).toBe(false);
    expect(tree.stopped(procs.supervisor.pid)).toBe(false);
    expect(tree.signals.some((row) => row.signal === "SIGTERM")).toBe(false);
    expect(tree.signals.every((row) => row.pid >= 10_000)).toBe(true);
  });

  test("missing identity marker fails closed and CONTs wrapper/supervisor", async () => {
    const tree = new FakeProcessTree();
    const procs = chain(tree);
    const result = await runIdentityChainInject({
      processes: tree,
      wrapper: procs.wrapper,
      supervisor: procs.supervisor,
      host: procs.host,
      diskSha: () => "sha-a",
      roles: () => tree.roles(),
      spawnHost: () => tree.spawn("host"),
      readMarker: () => undefined,
      wait: hangUntilAbort(),
      now: () => 0,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("marker-missing");
    expect(tree.stopped(procs.wrapper.pid)).toBe(false);
    expect(tree.stopped(procs.supervisor.pid)).toBe(false);
    expect(tree.signals.every((row) => row.pid >= 10_000 && row.exe.startsWith("/fake/"))).toBe(true);
  });
});
