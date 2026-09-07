import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAttestation, type CoverageAttestation, type RouteAttestation } from "../src/attestation.ts";
import { projectLiveStatus } from "../src/observe.ts";
import type { DesiredFile, ModelsFile } from "../src/models.ts";
import type { ProcessIdentity, ProcessPort, SignalName } from "../src/process.ts";
import type { PatchProfile } from "../src/transform.ts";

const MODELS: ModelsFile = { version: 1, models: {}, assignments: { main: "stub/echo", agents: {} } };
const SHA = "disk-sha-fixture";
const DECOY_DIR = join(tmpdir(), "box-runtime-keep-identity-ephemeral");
const REVIEWED: PatchProfile = {
  profileId: "reviewed-route",
  sourceSha256: SHA,
  transformedSourceSha256: "sha-transformed-route",
  slices: [
    { id: "create-session", startAnchor: "a", endAnchor: "b", find: "c", replacement: "d" },
    { id: "agent-id", startAnchor: "e", endAnchor: "f", find: "g", replacement: "h" },
  ],
};

function desired(mode: DesiredFile["mode"]): DesiredFile {
  return { version: 1, mode };
}

function ident(partial: Partial<ProcessIdentity> & Pick<ProcessIdentity, "pid" | "cmdline">): ProcessIdentity {
  return {
    uid: 1000,
    start: 1,
    exe: "/exec-daemon/node",
    ppid: 1,
    ancestry: [1],
    ...partial,
  };
}

function officialChain(hostOverrides: Partial<ProcessIdentity> = {}) {
  const wrapper = ident({
    pid: 11,
    exe: "/usr/local/bin/supervise-sand-supervisor",
    cmdline: ["/usr/local/bin/supervise-sand-supervisor"],
    ppid: 1,
    ancestry: [1],
  });
  const supervisor = ident({
    pid: 22,
    cmdline: ["/exec-daemon/node", "/usr/local/bin/sand-supervisor.mjs"],
    ppid: wrapper.pid,
    ancestry: [wrapper.pid, 1],
  });
  const host = ident({
    pid: 33,
    start: 100,
    cmdline: ["/exec-daemon/node", "/home/box/sand-host/host-main.cjs"],
    ppid: supervisor.pid,
    ancestry: [supervisor.pid, wrapper.pid, 1],
    ...hostOverrides,
  });
  return { wrapper, supervisor, host };
}

function portOf(list: ProcessIdentity[], signals: Array<{ pid: number; signal: SignalName }>): ProcessPort {
  return {
    inspect: (pid) => list.find((row) => row.pid === pid) ?? null,
    list: () => [...list],
    signal: (expected, signal) => {
      signals.push({ pid: expected.pid, signal });
      return { ok: false, reason: "not-found" };
    },
  };
}

function envHasMap(map: Record<number, readonly string[]>): (pid: number, key: string) => boolean {
  return (pid, key) => map[pid]?.includes(key) === true;
}

async function roots() {
  const root = await mkdtemp(join(tmpdir(), "grokbox-status-durable-"));
  const ephemeralRoot = await mkdtemp(join(tmpdir(), "grokbox-status-eph-"));
  return { root, ephemeralRoot };
}

async function snapshot(dir: string): Promise<string> {
  const names = (await readdir(dir, { recursive: true })).map(String).sort();
  const parts = await Promise.all(
    names.map(async (name) => {
      try {
        return `${name}:${await readFile(join(dir, name), "utf8")}`;
      } catch {
        return `${name}:`;
      }
    }),
  );
  return parts.join("\n");
}

async function statusFor(input: {
  mode: DesiredFile["mode"];
  list: ProcessIdentity[];
  env?: Record<number, readonly string[]>;
  diskSha?: string | null;
  att?: CoverageAttestation;
  signals?: Array<{ pid: number; signal: SignalName }>;
  reviewedProfile?: PatchProfile;
  modeld?: boolean;
}) {
  const { root, ephemeralRoot } = await roots();
  if (input.att) await writeAttestation(ephemeralRoot, input.att);
  const signals = input.signals ?? [];
  return await projectLiveStatus({
      root,
      desired: desired(input.mode),
      models: MODELS,
      processes: portOf(input.list, signals),
      ephemeralRoot,
      diskSha: input.diskSha === undefined ? SHA : input.diskSha,
      envHas: envHasMap(input.env ?? {}),
      modeldReady: () => input.modeld === true,
      ...(input.reviewedProfile ? { reviewedProfile: input.reviewedProfile } : {}),
    });
}

function attFor(host: ProcessIdentity, diskSha = SHA): CoverageAttestation {
  return {
    mode: "identity",
    coverage: "attested",
    diskSha,
    pid: host.pid,
    start: host.start,
    identity: host,
    at: "2026-09-05T00:00:00.000Z",
    modeld: false,
    windowMs: 12,
  };
}

function routeAttFor(host: ProcessIdentity, diskSha = SHA, overrides: Partial<RouteAttestation> = {}): RouteAttestation {
  return {
    mode: "route",
    coverage: "attested",
    diskSha,
    pid: host.pid,
    start: host.start,
    identity: host,
    at: "2026-09-05T00:00:00.000Z",
    modeld: true,
    profileId: REVIEWED.profileId,
    transformedSha: REVIEWED.transformedSourceSha256,
    windowMs: 12,
    ...overrides,
  };
}

describe("projectLiveStatus origin/coverage matrix", () => {
  test("official direct singleton, desired disabled → official / none", async () => {
    const { wrapper, supervisor, host } = officialChain();
    const status = await statusFor({ mode: "disabled", list: [wrapper, supervisor, host] });
    expect(status.host.origin).toBe("official");
    expect(status.host.reason).toBeNull();
    expect(status.coverage).toBe("none");
    expect(status.activation).toMatchObject({ desired: "disabled", actual: "official", reconcile: "converged" });
    expect(status.watchdog.state).toBe("unknown");
    expect(status.window.affectedInvocations).toBe("unknown");
  });

  test("official direct, desired identity, no att → official / window-open", async () => {
    const { wrapper, supervisor, host } = officialChain();
    const status = await statusFor({ mode: "identity", list: [wrapper, supervisor, host] });
    expect(status.host.origin).toBe("official");
    expect(status.host.reason).toBeNull();
    expect(status.coverage).toBe("window-open");
    expect(status.watchdog.state).toBe("unknown");
  });

  test("NODE_OPTIONS alone is not grokbox-touched", async () => {
    const { wrapper, supervisor, host } = officialChain();
    const status = await statusFor({
      mode: "disabled",
      list: [wrapper, supervisor, host],
      env: { [host.pid]: ["NODE_OPTIONS"] },
    });
    expect(status.host.origin).toBe("official");
    expect(status.coverage).toBe("none");
  });

  test("grokbox named env, no canonical att, desired disabled → unmanaged_preload", async () => {
    const { wrapper, supervisor, host } = officialChain();
    const status = await statusFor({
      mode: "disabled",
      list: [wrapper, supervisor, host],
      env: { [host.pid]: ["GROKBOX_PRELOAD_MODE"] },
    });
    expect(status.host.origin).toBe("grokbox-unattested");
    expect(status.host.reason).toBe("unmanaged_preload");
    expect(status.coverage).toBe("none");
  });

  test("grokbox named env with adopted parentage stays unmanaged, not transient-adopt", async () => {
    const { wrapper, supervisor, host } = officialChain({ pid: 33001, ppid: 1, ancestry: [1] });
    const status = await statusFor({
      mode: "identity",
      list: [wrapper, supervisor, host],
      env: { [host.pid]: ["GROKBOX_PRELOAD_MODE", "GROKBOX_OPERATION_ID"] },
    });
    expect(status.host.origin).toBe("grokbox-unattested");
    expect(status.host.reason).toBe("unmanaged_preload");
    expect(status.coverage).toBe("none");
    expect(JSON.stringify(status)).not.toContain("transient-adopt");
  });

  test("grokbox named env, stale canonical att → stale_attestation, never attested", async () => {
    const { wrapper, supervisor, host } = officialChain();
    const stale = { ...host, pid: 99, start: 9 };
    const status = await statusFor({
      mode: "identity",
      list: [wrapper, supervisor, host],
      env: { [host.pid]: ["GROKBOX_PRELOAD_MARKER"] },
      att: attFor(stale),
    });
    expect(status.host.origin).toBe("grokbox-unattested");
    expect(status.host.reason).toBe("stale_attestation");
    expect(status.coverage).toBe("none");
  });

  test("ownership exact, diskSha mismatch → grokbox-attested stale_attestation", async () => {
    const { wrapper, supervisor, host } = officialChain();
    const identity = await statusFor({
      mode: "identity",
      list: [wrapper, supervisor, host],
      env: { [host.pid]: ["GROKBOX_PRELOAD_MODE"] },
      att: attFor(host, "old-sha"),
      diskSha: SHA,
    });
    expect(identity.host.origin).toBe("grokbox-attested");
    expect(identity.host.reason).toBe("stale_attestation");
    expect(identity.coverage).toBe("window-open");
    expect(identity.host.diskSha).toBe(SHA);

    const disabled = await statusFor({
      mode: "disabled",
      list: [wrapper, supervisor, host],
      env: { [host.pid]: ["GROKBOX_PRELOAD_MODE"] },
      att: attFor(host, "old-sha"),
      diskSha: SHA,
    });
    expect(disabled.host.origin).toBe("grokbox-attested");
    expect(disabled.host.reason).toBe("stale_attestation");
    expect(disabled.coverage).toBe("none");
  });

  test("canonical att agrees on grokbox-touched singleton → grokbox-attested", async () => {
    const { wrapper, supervisor, host } = officialChain();
    const status = await statusFor({
      mode: "disabled",
      list: [wrapper, supervisor, host],
      env: { [host.pid]: ["GROKBOX_PRELOAD_MODE"] },
      att: attFor(host),
    });
    expect(status.host.origin).toBe("grokbox-attested");
    expect(status.host.reason).toBeNull();
    expect(status.coverage).toBe("attested");
    expect(status.window.durationMs).toBe(12);
    expect(status.activation).toMatchObject({ actual: "identity", reconcile: "pending", reason: "rollback_pending" });
    expect(status.watchdog.state).toBe("unknown");
  });

  test("duplicate Host role without grokbox touch → ambiguous", async () => {
    const { wrapper, supervisor, host } = officialChain();
    const extra = ident({
      pid: 44,
      cmdline: ["/exec-daemon/node", "/home/box/sand-host/host-main.cjs"],
      ppid: supervisor.pid,
      ancestry: [supervisor.pid, wrapper.pid, 1],
    });
    const status = await statusFor({ mode: "observe", list: [wrapper, supervisor, host, extra] });
    expect(status.host.origin).toBe("ambiguous");
    expect(status.host.reason).toBe("duplicate_role");
    expect(status.coverage).toBe("none");
  });
});

describe("projectLiveStatus observation bounds", () => {
  test("zero mutation: no durable/ephemeral writes, no signal, no /tmp readdir", async () => {
    const { root, ephemeralRoot } = await roots();
    const { wrapper, supervisor, host } = officialChain();
    const signals: Array<{ pid: number; signal: SignalName }> = [];
    const beforeDurable = await snapshot(root);
    const beforeEph = await snapshot(ephemeralRoot);
    const processes: ProcessPort = {
      inspect: (pid) => [wrapper, supervisor, host].find((row) => row.pid === pid) ?? null,
      list: () => [wrapper, supervisor, host],
      signal: (expected, signal) => {
        signals.push({ pid: expected.pid, signal });
        return { ok: false, reason: "not-found" };
      },
    };
    const status = await projectLiveStatus({
      root,
      desired: desired("disabled"),
      models: MODELS,
      processes,
      ephemeralRoot,
      diskSha: SHA,
      envHas: envHasMap({}),
    });
    expect(status.host.origin).toBe("official");
    expect(signals).toEqual([]);
    expect(await snapshot(root)).toBe(beforeDurable);
    expect(await snapshot(ephemeralRoot)).toBe(beforeEph);
    const src = await readFile(new URL("../src/observe.ts", import.meta.url), "utf8");
    expect(src).not.toContain("/tmp");
    expect(src).not.toContain("process.kill");
    expect(src).not.toContain("runTransientAdopt");
    expect(src).not.toContain("settleStaleAdoptJournal");
  });

  test("canonical att only: /tmp keep-identity decoy is ignored", async () => {
    const { wrapper, supervisor, host } = officialChain();
    await mkdir(DECOY_DIR, { recursive: true });
    const decoyFile = join(DECOY_DIR, "attestation.json");
    let previous: string | null = null;
    try {
      previous = await readFile(decoyFile, "utf8");
    } catch {
      previous = null;
    }
    await writeFile(decoyFile, `${JSON.stringify(attFor(host))}\n`);
    try {
      const status = await statusFor({
        mode: "disabled",
        list: [wrapper, supervisor, host],
        env: { [host.pid]: ["GROKBOX_PRELOAD_MODE"] },
      });
      expect(status.host.origin).toBe("grokbox-unattested");
      expect(status.host.reason).toBe("unmanaged_preload");
      expect(status.coverage).toBe("none");
    } finally {
      if (previous == null) {
        const { unlink } = await import("node:fs/promises");
        await unlink(decoyFile).catch(() => undefined);
      } else {
        await writeFile(decoyFile, previous);
      }
    }
  });
});

describe("projectLiveStatus route×modeld readiness", () => {
  test("desired=route + route att agrees + modeld stopped → window-open, not attested", async () => {
    const { wrapper, supervisor, host } = officialChain();
    const status = await statusFor({
      mode: "route",
      list: [wrapper, supervisor, host],
      env: { [host.pid]: ["GROKBOX_PRELOAD_MODE"] },
      att: routeAttFor(host),
      reviewedProfile: REVIEWED,
    });
    expect(status.host.origin).toBe("grokbox-attested");
    expect(status.host.reason).toBeNull();
    expect(status.coverage).toBe("window-open");
    expect(status.activation.desired).toBe("route");
    expect(status.modeld).toEqual({ required: true, state: "stopped" });
  });

  test("desired=route + route att agrees + modeld up → attested / route-ready", async () => {
    const { wrapper, supervisor, host } = officialChain();
    const status = await statusFor({
      mode: "route",
      list: [wrapper, supervisor, host],
      env: { [host.pid]: ["GROKBOX_PRELOAD_MODE"] },
      att: routeAttFor(host),
      reviewedProfile: REVIEWED,
      modeld: true,
    });
    expect(status.host.origin).toBe("grokbox-attested");
    expect(status.host.reason).toBeNull();
    expect(status.coverage).toBe("attested");
    expect(status.modeld).toEqual({ required: true, state: "running" });
    expect(status.window.durationMs).toBe(12);
  });

  test("desired=route alone with identity att never reports attested/route-ready", async () => {
    const { wrapper, supervisor, host } = officialChain();
    const status = await statusFor({
      mode: "route",
      list: [wrapper, supervisor, host],
      env: { [host.pid]: ["GROKBOX_PRELOAD_MODE"] },
      att: attFor(host),
      reviewedProfile: REVIEWED,
      modeld: true,
    });
    expect(status.host.origin).toBe("grokbox-attested");
    expect(status.host.reason).toBeNull();
    expect(status.coverage).toBe("window-open");
    expect(status.modeld).toEqual({ required: true, state: "running" });
  });

  test("desired=route + profile mismatch + modeld up → window-open", async () => {
    const { wrapper, supervisor, host } = officialChain();
    const status = await statusFor({
      mode: "route",
      list: [wrapper, supervisor, host],
      env: { [host.pid]: ["GROKBOX_PRELOAD_MODE"] },
      att: routeAttFor(host, SHA, { profileId: "stale-profile", transformedSha: "stale-transformed" }),
      reviewedProfile: REVIEWED,
      modeld: true,
    });
    expect(status.host.origin).toBe("grokbox-attested");
    expect(status.host.reason).toBeNull();
    expect(status.coverage).toBe("window-open");
    expect(status.modeld).toEqual({ required: true, state: "running" });
  });

  test("desired=identity keeps attested without modeld; modeld.required=false", async () => {
    const { wrapper, supervisor, host } = officialChain();
    const status = await statusFor({
      mode: "identity",
      list: [wrapper, supervisor, host],
      env: { [host.pid]: ["GROKBOX_PRELOAD_MODE"] },
      att: attFor(host),
    });
    expect(status.host.origin).toBe("grokbox-attested");
    expect(status.coverage).toBe("attested");
    expect(status.modeld).toEqual({ required: false, state: "stopped" });
  });

  test("official desired=route projects modeld required/stopped and window-open", async () => {
    const { wrapper, supervisor, host } = officialChain();
    const status = await statusFor({ mode: "route", list: [wrapper, supervisor, host] });
    expect(status.host.origin).toBe("official");
    expect(status.coverage).toBe("window-open");
    expect(status.modeld).toEqual({ required: true, state: "stopped" });
  });
});
