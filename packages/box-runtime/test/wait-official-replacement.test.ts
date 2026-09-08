import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitOfficialReplacement } from "../src/internal/process/official-chain.ts";
import { runTransientAdoptDeactivate } from "../src/internal/process/transient-adopt.ts";
import { FakeProcessTree } from "./fake-tree.ts";

function classify(tree: FakeProcessTree) {
  return (ident: { pid: number }) => {
    const row = tree.roles().find((role) => role.pid === ident.pid);
    if (row?.role === "wrapper" || row?.role === "supervisor" || row?.role === "host") return row.role;
    return null;
  };
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function queuedClock() {
  let t = 0;
  const q: Array<{ ms: number; resolve: () => void }> = [];
  return {
    now: () => t,
    sleep: (ms: number) => new Promise<void>((resolve) => { q.push({ ms, resolve }); }),
    async advance() {
      const next = q.shift();
      if (!next) throw new Error("no queued sleep");
      t += next.ms;
      next.resolve();
      await Promise.resolve();
    },
    time: () => t,
  };
}

function spawnOfficial(tree: FakeProcessTree) {
  const wrapper = tree.spawn("wrapper");
  const supervisor = tree.spawn("supervisor", { parent: wrapper });
  const host = tree.spawn("host", { parent: supervisor });
  return { wrapper, supervisor, host };
}

function spawnAdopted(tree: FakeProcessTree) {
  const wrapper = tree.spawn("wrapper");
  const supervisor = tree.spawn("supervisor", { parent: wrapper });
  const host = tree.spawn("host");
  return { wrapper, supervisor, host };
}

describe("waitOfficialReplacement", () => {
  test("does not succeed while Host is visible but Gateway pid is unpublished", async () => {
    const tree = new FakeProcessTree();
    const { supervisor, host: old } = spawnOfficial(tree);
    tree.kill(old);
    const born = tree.spawn("host", { parent: supervisor });
    const gateway = { pid: null as number | null };
    const clock = queuedClock();
    const wall = Date.now();
    const pending = waitOfficialReplacement({
      oldPid: old.pid,
      processes: tree,
      classify: classify(tree),
      hasGrokboxPreload: () => false,
      readGatewayPid: () => gateway.pid,
      budgetMs: 400,
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(gateway.pid).toBeNull();
    gateway.pid = born.pid;
    await clock.advance();
    const got = await pending;
    expect(got?.pid).toBe(born.pid);
    expect(got?.start).toBe(born.start);
    expect(Date.now() - wall).toBeLessThan(80);
  });

  test("times out when Gateway stays on the old pid or null", async () => {
    const tree = new FakeProcessTree();
    const { supervisor, host: old } = spawnOfficial(tree);
    tree.kill(old);
    tree.spawn("host", { parent: supervisor });
    const clock = queuedClock();
    const pending = waitOfficialReplacement({
      oldPid: old.pid,
      processes: tree,
      classify: classify(tree),
      hasGrokboxPreload: () => false,
      readGatewayPid: () => old.pid,
      budgetMs: 80,
      now: clock.now,
      sleep: clock.sleep,
    });
    await clock.advance();
    await clock.advance();
    expect(await pending).toBeNull();
    expect(clock.time()).toBeGreaterThanOrEqual(80);
  });

  test("refuses when the pinned candidate dies before Gateway publish", async () => {
    const tree = new FakeProcessTree();
    const { supervisor, host: old } = spawnOfficial(tree);
    tree.kill(old);
    const born = tree.spawn("host", { parent: supervisor });
    const clock = queuedClock();
    const pending = waitOfficialReplacement({
      oldPid: old.pid,
      processes: tree,
      classify: classify(tree),
      hasGrokboxPreload: () => false,
      readGatewayPid: () => null,
      budgetMs: 400,
      now: clock.now,
      sleep: clock.sleep,
    });
    tree.kill(born);
    await clock.advance();
    expect(await pending).toBeNull();
  });

  test("refuses PID reuse of the pinned candidate", async () => {
    const tree = new FakeProcessTree();
    const { supervisor, host: old } = spawnOfficial(tree);
    tree.kill(old);
    const born = tree.spawn("host", { parent: supervisor });
    const clock = queuedClock();
    const pending = waitOfficialReplacement({
      oldPid: old.pid,
      processes: tree,
      classify: classify(tree),
      hasGrokboxPreload: () => false,
      readGatewayPid: () => null,
      budgetMs: 400,
      now: clock.now,
      sleep: clock.sleep,
    });
    tree.kill(born);
    tree.spawn("host", { pid: born.pid, parent: supervisor });
    await clock.advance();
    expect(await pending).toBeNull();
  });

  test("refuses a competing Host instead of chasing it", async () => {
    const tree = new FakeProcessTree();
    const { supervisor, host: old } = spawnOfficial(tree);
    tree.kill(old);
    tree.spawn("host", { parent: supervisor });
    const clock = queuedClock();
    const pending = waitOfficialReplacement({
      oldPid: old.pid,
      processes: tree,
      classify: classify(tree),
      hasGrokboxPreload: () => false,
      readGatewayPid: () => null,
      budgetMs: 400,
      now: clock.now,
      sleep: clock.sleep,
    });
    tree.spawn("host", { parent: supervisor });
    await clock.advance();
    expect(await pending).toBeNull();
  });
});

describe("runTransientAdoptDeactivate replacement Gateway proof", () => {
  test("delayed Gateway publish after Host spawn succeeds; publish-before-return is not required", async () => {
    const tree = new FakeProcessTree();
    const { wrapper, supervisor, host } = spawnAdopted(tree);
    const patchedPid = host.pid;
    const gateway = { pid: host.pid as number | null };
    let cleared = 0;
    let bornPid: number | undefined;
    const result = await runTransientAdoptDeactivate({
      processes: tree,
      classify: classify(tree),
      diskSha: () => "sha-reviewed",
      ephemeralRoot: await mkdtemp(join(tmpdir(), "grokbox-wait-gw-ok-")),
      attestation: { identity: host, diskSha: "sha-reviewed" },
      waitGone: async (old) => tree.inspect(old.pid) === null,
      waitReplacement: async (oldPid) => {
        const born = tree.spawn("host", { parent: supervisor });
        bornPid = born.pid;
        void delay(25).then(() => {
          gateway.pid = born.pid;
        });
        return await waitOfficialReplacement({
          oldPid,
          processes: tree,
          classify: classify(tree),
          hasGrokboxPreload: (ident) => ident.pid === patchedPid,
          readGatewayPid: () => gateway.pid,
          budgetMs: 400,
        });
      },
      hasGrokboxPreload: (ident) => ident.pid === patchedPid,
      readGatewayPid: () => gateway.pid,
      clearAttestation: async () => {
        cleared += 1;
      },
    });
    expect(result.code ?? "ok").toBe("ok");
    expect(result.ok).toBe(true);
    expect(cleared).toBe(1);
    if (bornPid === undefined) throw new Error("expected replacement pid");
    expect(result.host?.pid).toBe(bornPid);
    expect(gateway.pid).toBe(bornPid);
    expect(tree.alive(wrapper.pid)).toBe(true);
    expect(tree.signals.some((row) => row.signal === "SIGKILL")).toBe(false);
  });

  test("Host-visible without Gateway publish fails replacement-gateway-unproven and does not clear attestation", async () => {
    const tree = new FakeProcessTree();
    const { supervisor, host } = spawnAdopted(tree);
    const patchedPid = host.pid;
    const gateway = { pid: host.pid as number | null };
    let cleared = 0;
    const termsBefore = tree.signals.filter((row) => row.signal === "SIGTERM").length;
    const result = await runTransientAdoptDeactivate({
      processes: tree,
      classify: classify(tree),
      diskSha: () => "sha-reviewed",
      ephemeralRoot: await mkdtemp(join(tmpdir(), "grokbox-wait-gw-late-")),
      attestation: { identity: host, diskSha: "sha-reviewed" },
      waitGone: async (old) => tree.inspect(old.pid) === null,
      waitReplacement: async (oldPid) => {
        tree.spawn("host", { parent: supervisor });
        return await waitOfficialReplacement({
          oldPid,
          processes: tree,
          classify: classify(tree),
          hasGrokboxPreload: (ident) => ident.pid === patchedPid,
          readGatewayPid: () => gateway.pid,
          budgetMs: 80,
        });
      },
      hasGrokboxPreload: (ident) => ident.pid === patchedPid,
      readGatewayPid: () => gateway.pid,
      clearAttestation: async () => {
        cleared += 1;
      },
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("replacement-gateway-unproven");
    expect(result.signaled).toBe(true);
    expect(cleared).toBe(0);
    expect(gateway.pid).toBe(patchedPid);
    expect(tree.signals.filter((row) => row.signal === "SIGTERM").length).toBe(termsBefore + 1);
    expect(tree.signals.some((row) => row.signal === "SIGKILL")).toBe(false);
  });

  test("non-compliant wait that returns before Gateway still fails the final pid check", async () => {
    const tree = new FakeProcessTree();
    const { supervisor, host } = spawnAdopted(tree);
    const patchedPid = host.pid;
    const gateway = { pid: host.pid as number | null };
    let cleared = 0;
    const result = await runTransientAdoptDeactivate({
      processes: tree,
      classify: classify(tree),
      diskSha: () => "sha-reviewed",
      ephemeralRoot: await mkdtemp(join(tmpdir(), "grokbox-wait-gw-early-")),
      attestation: { identity: host, diskSha: "sha-reviewed" },
      waitGone: async (old) => tree.inspect(old.pid) === null,
      waitReplacement: async () => tree.spawn("host", { parent: supervisor }),
      hasGrokboxPreload: (ident) => ident.pid === patchedPid,
      readGatewayPid: () => gateway.pid,
      clearAttestation: async () => {
        cleared += 1;
      },
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("replacement-gateway-unproven");
    expect(cleared).toBe(0);
  });

  test("source SHA drift after TERM fails closed without chasing Gateway", async () => {
    const tree = new FakeProcessTree();
    const { supervisor, host } = spawnAdopted(tree);
    const patchedPid = host.pid;
    let sha = "sha-reviewed";
    let cleared = 0;
    const result = await runTransientAdoptDeactivate({
      processes: tree,
      classify: classify(tree),
      diskSha: () => sha,
      ephemeralRoot: await mkdtemp(join(tmpdir(), "grokbox-wait-gw-sha-")),
      attestation: { identity: host, diskSha: "sha-reviewed" },
      waitGone: async (old) => tree.inspect(old.pid) === null,
      waitReplacement: async (oldPid) => {
        const born = tree.spawn("host", { parent: supervisor });
        sha = "sha-drift";
        return await waitOfficialReplacement({
          oldPid,
          processes: tree,
          classify: classify(tree),
          hasGrokboxPreload: (ident) => ident.pid === patchedPid,
          readGatewayPid: () => born.pid,
          budgetMs: 200,
        });
      },
      hasGrokboxPreload: (ident) => ident.pid === patchedPid,
      readGatewayPid: () => tree.roles().find((row) => row.role === "host")?.pid ?? null,
      clearAttestation: async () => {
        cleared += 1;
      },
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("disk-sha-changed");
    expect(cleared).toBe(0);
  });
});
