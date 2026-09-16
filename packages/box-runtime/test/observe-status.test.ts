import { describe, expect, spyOn, test } from "bun:test";
import { constants as fsConstants } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAttestation, type CoverageAttestation, type RouteAttestation } from "../src/internal/io/authority.node.ts";
import { createStatusPortCounts, projectLiveStatus } from "../src/internal/io/observe.ts";
import { appendHostJournal } from "../src/internal/host/terminal-journal.node.ts";
import * as artifacts from "../src/internal/io/artifacts.node.ts";
import * as credentials from "../src/internal/io/credentials.node.ts";
import * as journal from "../src/internal/io/journal.node.ts";
import type { DesiredFile, ModelsFile } from "@grokbox/runtime-kernel/selection";
import type { ProcessIdentity, ProcessPort, SignalName } from "../src/internal/process/process-port.ts";
import type { PatchProfile } from "../src/internal/host/profile.ts";

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
    expect(status.facets.bridge.value?.origin).toBe("official");
    expect(status.facets.bridge.value?.reason).toBeNull();
    expect(status.facets.bridge.value?.coverage).toBe("none");
    expect(status.facets.bridge.value).toMatchObject({ desired: "disabled", actual: "official" });
    expect(status).not.toHaveProperty("watchdog");
    expect(status.facets.controller.value?.liveness).toBe("unknown");
    expect(status.schemaVersion).toBe(1);
  });

  test("official direct, desired identity, no att → official / window-open", async () => {
    const { wrapper, supervisor, host } = officialChain();
    const status = await statusFor({ mode: "identity", list: [wrapper, supervisor, host] });
    expect(status.facets.bridge.value?.origin).toBe("official");
    expect(status.facets.bridge.value?.reason).toBeNull();
    expect(status.facets.bridge.value?.coverage).toBe("window-open");
    expect(status).not.toHaveProperty("watchdog");
    expect(status.facets.controller.value?.liveness).toBe("unknown");
  });

  test("NODE_OPTIONS alone is not grokbox-touched", async () => {
    const { wrapper, supervisor, host } = officialChain();
    const status = await statusFor({
      mode: "disabled",
      list: [wrapper, supervisor, host],
      env: { [host.pid]: ["NODE_OPTIONS"] },
    });
    expect(status.facets.bridge.value?.origin).toBe("official");
    expect(status.facets.bridge.value?.coverage).toBe("none");
  });

  test("grokbox named env, no canonical att, desired disabled → unmanaged_preload", async () => {
    const { wrapper, supervisor, host } = officialChain();
    const status = await statusFor({
      mode: "disabled",
      list: [wrapper, supervisor, host],
      env: { [host.pid]: ["GROKBOX_PRELOAD_MODE"] },
    });
    expect(status.facets.bridge.value?.origin).toBe("grokbox-unattested");
    expect(status.facets.bridge.value?.reason).toBe("unmanaged_preload");
    expect(status.facets.bridge.value?.coverage).toBe("none");
  });

  test("grokbox named env with adopted parentage stays unmanaged, not transient-adopt", async () => {
    const { wrapper, supervisor, host } = officialChain({ pid: 33001, ppid: 1, ancestry: [1] });
    const status = await statusFor({
      mode: "identity",
      list: [wrapper, supervisor, host],
      env: { [host.pid]: ["GROKBOX_PRELOAD_MODE", "GROKBOX_OPERATION_ID"] },
    });
    expect(status.facets.bridge.value?.origin).toBe("grokbox-unattested");
    expect(status.facets.bridge.value?.reason).toBe("unmanaged_preload");
    expect(status.facets.bridge.value?.coverage).toBe("none");
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
    expect(status.facets.bridge.value?.origin).toBe("grokbox-unattested");
    expect(status.facets.bridge.value?.reason).toBe("stale_attestation");
    expect(status.facets.bridge.value?.coverage).toBe("none");
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
    expect(identity.facets.bridge.value?.origin).toBe("grokbox-attested");
    expect(identity.facets.bridge.value?.reason).toBe("stale_attestation");
    expect(identity.facets.bridge.value?.coverage).toBe("window-open");
    expect(identity.facets.bridge.value?.origin).toBe("grokbox-attested");

    const disabled = await statusFor({
      mode: "disabled",
      list: [wrapper, supervisor, host],
      env: { [host.pid]: ["GROKBOX_PRELOAD_MODE"] },
      att: attFor(host, "old-sha"),
      diskSha: SHA,
    });
    expect(disabled.facets.bridge.value?.origin).toBe("grokbox-attested");
    expect(disabled.facets.bridge.value?.reason).toBe("stale_attestation");
    expect(disabled.facets.bridge.value?.coverage).toBe("none");
  });

  test("canonical att agrees on grokbox-touched singleton → grokbox-attested", async () => {
    const { wrapper, supervisor, host } = officialChain();
    const status = await statusFor({
      mode: "disabled",
      list: [wrapper, supervisor, host],
      env: { [host.pid]: ["GROKBOX_PRELOAD_MODE"] },
      att: attFor(host),
    });
    expect(status.facets.bridge.value?.origin).toBe("grokbox-attested");
    expect(status.facets.bridge.value?.reason).toBeNull();
    expect(status.facets.bridge.value?.coverage).toBe("attested");
    expect(status.facets.bridge.value?.coverage).toBe("attested");
    expect(status.facets.bridge.value).toMatchObject({ actual: "identity", coverage: "attested" });
    expect(status).not.toHaveProperty("watchdog");
    expect(status.facets.controller.value?.liveness).toBe("unknown");
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
    expect(status.facets.bridge.value?.origin).toBe("ambiguous");
    expect(status.facets.bridge.value?.reason).toBe("duplicate_role");
    expect(status.facets.bridge.value?.coverage).toBe("none");
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
    expect(status.facets.bridge.value?.origin).toBe("official");
    expect(signals).toEqual([]);
    expect(await snapshot(root)).toBe(beforeDurable);
    expect(await snapshot(ephemeralRoot)).toBe(beforeEph);
    const src = await readFile(new URL("../src/internal/io/observe.ts", import.meta.url), "utf8");
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
      expect(status.facets.bridge.value?.origin).toBe("grokbox-unattested");
      expect(status.facets.bridge.value?.reason).toBe("unmanaged_preload");
      expect(status.facets.bridge.value?.coverage).toBe("none");
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
  const unqualified = { liveness: "unknown", admission: "not_observed", protocolComparison: "observer_to_modeld", hostProtocolCompatibility: "not_observed" } as const;
  test("desired=route + route att agrees + modeld stopped → window-open, not attested", async () => {
    const { wrapper, supervisor, host } = officialChain();
    const status = await statusFor({
      mode: "route",
      list: [wrapper, supervisor, host],
      env: { [host.pid]: ["GROKBOX_PRELOAD_MODE"] },
      att: routeAttFor(host),
      reviewedProfile: REVIEWED,
    });
    expect(status.facets.bridge.value?.origin).toBe("grokbox-attested");
    expect(status.facets.bridge.value?.reason).toBeNull();
    expect(status.facets.bridge.value?.coverage).toBe("window-open");
    expect(status.facets.bridge.value?.desired).toBe("route");
    expect(status.facets.modeld.value).toEqual({ required: true, ready: false, ...unqualified });
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
    expect(status.facets.bridge.value?.origin).toBe("grokbox-attested");
    expect(status.facets.bridge.value?.reason).toBeNull();
    expect(status.facets.bridge.value?.coverage).toBe("attested");
    expect(status.facets.modeld.value).toEqual({ required: true, ready: true, ...unqualified });
    expect(status.facets.bridge.value?.coverage).toBe("attested");
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
    expect(status.facets.bridge.value?.origin).toBe("grokbox-attested");
    expect(status.facets.bridge.value?.reason).toBeNull();
    expect(status.facets.bridge.value?.coverage).toBe("window-open");
    expect(status.facets.modeld.value).toEqual({ required: true, ready: true, ...unqualified });
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
    expect(status.facets.bridge.value?.origin).toBe("grokbox-attested");
    expect(status.facets.bridge.value?.reason).toBeNull();
    expect(status.facets.bridge.value?.coverage).toBe("window-open");
    expect(status.facets.modeld.value).toEqual({ required: true, ready: true, ...unqualified });
  });

  test("desired=identity keeps attested without modeld; modeld.required=false", async () => {
    const { wrapper, supervisor, host } = officialChain();
    const status = await statusFor({
      mode: "identity",
      list: [wrapper, supervisor, host],
      env: { [host.pid]: ["GROKBOX_PRELOAD_MODE"] },
      att: attFor(host),
    });
    expect(status.facets.bridge.value?.origin).toBe("grokbox-attested");
    expect(status.facets.bridge.value?.coverage).toBe("attested");
    expect(status.facets.modeld.value).toEqual({ required: false, ready: false, ...unqualified });
  });

  test("official desired=route projects modeld required/stopped and window-open", async () => {
    const { wrapper, supervisor, host } = officialChain();
    const status = await statusFor({ mode: "route", list: [wrapper, supervisor, host] });
    expect(status.facets.bridge.value?.origin).toBe("official");
    expect(status.facets.bridge.value?.coverage).toBe("window-open");
    expect(status.facets.modeld.value).toEqual({ required: true, ready: false, ...unqualified });
  });
});

describe("status facets IO wiring", () => {
  test("attested coverage with stored open circuit inhibits mutation and keeps liveness unknown", async () => {
    const { wrapper, supervisor, host } = officialChain();
    const { root, ephemeralRoot } = await roots();
    await writeAttestation(ephemeralRoot, attFor(host));
    await mkdir(join(root, "state"), { recursive: true });
    await writeFile(join(root, "state", "coordinator.json"), JSON.stringify({
      version: 1, circuit: "open", mutationCount: 1, attemptedKeys: ["k"], circuitReason: "unsupported_bundle",
    }));
    const status = await projectLiveStatus({
      root,
      desired: desired("identity"),
      models: MODELS,
      processes: portOf([wrapper, supervisor, host], []),
      ephemeralRoot,
      diskSha: SHA,
      envHas: envHasMap({ [host.pid]: ["GROKBOX_PRELOAD_MODE"] }),
    });
    expect(status.facets.bridge.value?.coverage).toBe("attested");
    expect(status.circuit.value).toEqual({ state: "open", reason: "unsupported_bundle" });
    expect(status.facets.mutation.value?.inhibited).toBe(true);
    expect(status.facets.controller.value?.liveness).toBe("unknown");
    expect(JSON.stringify(status)).not.toContain("degraded");
    expect(status).not.toHaveProperty("watchdog");
  });

  test("readonly counted ports wrap real seams; violations make the zero oracle fail", async () => {
    const counts = createStatusPortCounts();
    const originalWrite = artifacts.writeRuntimeArtifact;
    const originalCredential = credentials.materializeApiKeyRef;
    const originalCompact = journal.compactEvents;
    const originalOpen = fsp.open;
    const originalWriteFile = fsp.writeFile;
    const originalAppendFile = fsp.appendFile;
    const originalFetch = globalThis.fetch;
    const isWriteOpen = (flags: unknown): boolean => {
      if (typeof flags === "string") return /[aw+]/.test(flags);
      if (typeof flags === "number") {
        return (flags & (fsConstants.O_WRONLY | fsConstants.O_RDWR | fsConstants.O_APPEND | fsConstants.O_TRUNC)) !== 0;
      }
      return false;
    };
    const spies = [
      spyOn(fsp, "open").mockImplementation(((path: Parameters<typeof fsp.open>[0], flags?: unknown, mode?: unknown) => {
        if (isWriteOpen(flags)) counts.write += 1;
        return originalOpen(path, flags as never, mode as never);
      }) as typeof fsp.open),
      spyOn(fsp, "writeFile").mockImplementation(((path, data, options) => {
        counts.write += 1;
        return originalWriteFile(path, data, options as never);
      }) as typeof fsp.writeFile),
      spyOn(fsp, "appendFile").mockImplementation(((path, data, options) => {
        counts.write += 1;
        return originalAppendFile(path, data, options as never);
      }) as typeof fsp.appendFile),
      spyOn(artifacts, "writeRuntimeArtifact").mockImplementation(async (path, value) => {
        counts.write += 1;
        return originalWrite(path, value);
      }),
      spyOn(credentials, "materializeApiKeyRef").mockImplementation(async (ref, env, signal) => {
        counts.credential += 1;
        return originalCredential(ref, env, signal);
      }),
      spyOn(journal, "compactEvents").mockImplementation(async (root) => {
        counts.compaction += 1;
        return originalCompact(root);
      }),
    ];
    const deny = async (): Promise<Response> => {
      counts.provider += 1;
      return new Response("{}", { status: 200 });
    };
    globalThis.fetch = Object.assign(deny, { preconnect: deny }) as typeof fetch;
    const { wrapper, supervisor, host } = officialChain();
    const { root, ephemeralRoot } = await roots();
    const before = await snapshot(root);
    try {
      const status = await projectLiveStatus({
        root,
        desired: desired("disabled"),
        models: MODELS,
        processes: {
          inspect: (pid) => [wrapper, supervisor, host].find((row) => row.pid === pid) ?? null,
          list: () => [wrapper, supervisor, host],
          signal: () => {
            counts.signal += 1;
            return { ok: false, reason: "not-found" };
          },
        },
        ephemeralRoot,
        diskSha: SHA,
        envHas: envHasMap({}),
      });
      expect(status.schemaVersion).toBe(1);
      expect(counts).toEqual({ write: 0, signal: 0, credential: 0, provider: 0, compaction: 0 });
      expect(await snapshot(root)).toBe(before);
      const src = await readFile(new URL("../src/internal/io/observe.ts", import.meta.url), "utf8");
      expect(src).not.toContain("compactEvents");
      expect(src).not.toContain("writeAttestation");
      expect(src).not.toContain("materializeApiKeyRef");

      const marker = join(tmpdir(), "t27-status-write-marker.ndjson");
      const handle = await fsp.open(marker, "a");
      try { await handle.write("synthetic-status-write\n"); }
      finally { await handle.close(); }
      expect(counts.write).toBeGreaterThan(0);
      const afterOpen = counts.write;
      await (await import("node:fs/promises")).writeFile(marker, "synthetic-status-write\n", { flag: "a" });
      expect(counts.write).toBeGreaterThan(afterOpen);
      const afterWriteFile = counts.write;
      await (await import("node:fs/promises")).appendFile(marker, "synthetic-status-write\n");
      expect(counts.write).toBeGreaterThan(afterWriteFile);
      await credentials.materializeApiKeyRef("env:T27_STATUS_SENTINEL", { T27_STATUS_SENTINEL: "synthetic-not-a-real-key" });
      await journal.compactEvents(root);
      await globalThis.fetch("https://ccs.test/status-must-not-call");
      expect(counts.write).toBeGreaterThan(afterWriteFile);
      expect(counts.credential).toBeGreaterThan(0);
      expect(counts.compaction).toBeGreaterThan(0);
      expect(counts.provider).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = originalFetch;
      for (const spy of spies) spy.mockRestore();
    }
  });

  test("host_normalized_terminal append observes as host_terminal with full or missing tuple", async () => {
    const { wrapper, supervisor, host } = officialChain();
    const { root, ephemeralRoot } = await roots();
    await mkdir(join(ephemeralRoot, "log"), { recursive: true });
    expect(await appendHostJournal(ephemeralRoot, {
      name: "host_normalized_terminal",
      at: "2026-01-01T00:00:00.000Z",
      hostId: "host-1",
      agentId: "agent-tom",
      turnId: "turn-1",
      stepId: "step-1",
      serviceEpoch: "epoch-1",
      binding: "bind-1",
      attempt: "1",
      invocationId: "inv-must-not-become-attempt",
      authorization: "sk-live-SENTINEL_SECRET",
    })).toBe("written");
    const full = await projectLiveStatus({
      root,
      desired: desired("disabled"),
      models: MODELS,
      processes: portOf([wrapper, supervisor, host], []),
      ephemeralRoot,
      diskSha: SHA,
      envHas: envHasMap({}),
    });
    expect(full.facets.hostDelivery.gap).toBeNull();
    expect(full.facets.hostDelivery.value).toEqual({
      kind: "host_terminal",
      correlated: true,
      tuple: {
        hostId: "host-1",
        agentId: "agent-tom",
        turnId: "turn-1",
        stepId: "step-1",
        serviceEpoch: "epoch-1",
        binding: "bind-1",
        attempt: "1",
      },
    });
    expect(JSON.stringify(full)).not.toContain("inv-must-not-become-attempt");
    expect(JSON.stringify(full)).not.toContain("sk-live-SENTINEL_SECRET");

    const missingRoots = await roots();
    await mkdir(join(missingRoots.ephemeralRoot, "log"), { recursive: true });
    expect(await appendHostJournal(missingRoots.ephemeralRoot, {
      name: "host_normalized_terminal",
      at: "2026-01-01T00:00:00.000Z",
      agentId: "agent-tom",
      turnId: "turn-1",
    })).toBe("written");
    const missing = await projectLiveStatus({
      root: missingRoots.root,
      desired: desired("disabled"),
      models: MODELS,
      processes: portOf([wrapper, supervisor, host], []),
      ephemeralRoot: missingRoots.ephemeralRoot,
      diskSha: SHA,
      envHas: envHasMap({}),
    });
    expect(missing.facets.hostDelivery.value?.kind).toBe("host_terminal");
    expect(missing.facets.hostDelivery.value?.correlated).toBe(false);
    expect(missing.facets.hostDelivery.value?.tuple).toEqual({ agentId: "agent-tom", turnId: "turn-1" });
  });
});
