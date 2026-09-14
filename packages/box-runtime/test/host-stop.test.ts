import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CoverageAttestation } from "../src/internal/io/authority.node.ts";
import { stopPatchedHostCoverage } from "../src/internal/process/host-stop.ts";
import type { ProcessIdentity } from "../src/internal/process/process-port.ts";
import { FakeProcessTree } from "./fake-tree.ts";

function classify(tree: FakeProcessTree) {
  return (ident: { pid: number }) => {
    const row = tree.roles().find((role) => role.pid === ident.pid);
    if (row?.role === "wrapper" || row?.role === "supervisor" || row?.role === "host") return row.role;
    if (row?.role === "temp-supervisor") return "temp-supervisor";
    return null;
  };
}

function attestationFor(host: ProcessIdentity, extras: Partial<CoverageAttestation> = {}): CoverageAttestation {
  return {
    coverage: "attested",
    diskSha: "sha-reviewed",
    pid: host.pid,
    start: host.start,
    identity: host,
    at: new Date(0).toISOString(),
    launchMode: "transient-adopt",
    mode: "route",
    modeld: true,
    profileId: "reviewed",
    transformedSha: "sha-transformed",
    ...extras,
  } as CoverageAttestation;
}

describe("stopPatchedHostCoverage", () => {
  test("already-official unique chain with no attestation is a zero-signal success", async () => {
    const tree = new FakeProcessTree();
    const wrapper = tree.spawn("wrapper");
    const supervisor = tree.spawn("supervisor", { parent: wrapper });
    const host = tree.spawn("host", { parent: supervisor });
    const result = await stopPatchedHostCoverage({
      processes: tree,
      classify: classify(tree),
      diskSha: () => "sha-reviewed",
      ephemeralRoot: await mkdtemp(join(tmpdir(), "grokbox-host-stop-")),
      waitGone: async () => true,
      waitReplacement: async () => null,
      hasGrokboxPreload: () => false,
      readGatewayPid: () => host.pid,
      readAttestationRecord: async () => null,
      clearAttestation: async () => {
        throw new Error("must not clear");
      },
    });
    expect(result).toMatchObject({ ok: true, signaled: false, coverage: "none", recoveryRequired: false });
    expect(result.host?.pid).toBe(host.pid);
    expect(tree.signals).toEqual([]);
    expect(tree.alive(host.pid)).toBe(true);
  });

  test("patched Host without attestation fails closed without signaling", async () => {
    const tree = new FakeProcessTree();
    const wrapper = tree.spawn("wrapper");
    const supervisor = tree.spawn("supervisor", { parent: wrapper });
    const host = tree.spawn("host", { parent: wrapper });
    const result = await stopPatchedHostCoverage({
      processes: tree,
      classify: classify(tree),
      diskSha: () => "sha-reviewed",
      ephemeralRoot: await mkdtemp(join(tmpdir(), "grokbox-host-stop-")),
      waitGone: async () => true,
      waitReplacement: async () => null,
      hasGrokboxPreload: (ident) => ident.pid === host.pid,
      readGatewayPid: () => host.pid,
      readAttestationRecord: async () => null,
      clearAttestation: async () => {
        throw new Error("must not clear");
      },
    });
    expect(result).toMatchObject({ ok: false, signaled: false, code: "no-attestation" });
    expect(tree.signals).toEqual([]);
    expect(tree.alive(host.pid)).toBe(true);
  });

  test("route attestation unloads patched Host and proves supervisor-owned official replacement", async () => {
    const tree = new FakeProcessTree();
    const wrapper = tree.spawn("wrapper");
    const supervisor = tree.spawn("supervisor", { parent: wrapper });
    const host = tree.spawn("host", { parent: wrapper });
    const patchedPid = host.pid;
    let gatewayPid = host.pid;
    let cleared = false;
    const result = await stopPatchedHostCoverage({
      processes: tree,
      classify: classify(tree),
      diskSha: () => "sha-reviewed",
      ephemeralRoot: await mkdtemp(join(tmpdir(), "grokbox-host-stop-")),
      waitGone: async (old) => tree.inspect(old.pid) === null,
      waitReplacement: async () => {
        const born = tree.spawn("host", { parent: supervisor });
        gatewayPid = born.pid;
        return born;
      },
      hasGrokboxPreload: (ident) => ident.pid === patchedPid,
      readGatewayPid: () => gatewayPid,
      readAttestationRecord: async () => attestationFor(host),
      clearAttestation: async () => {
        cleared = true;
      },
    });
    expect(result.code ?? "ok").toBe("ok");
    expect(result.ok).toBe(true);
    expect(result.signaled).toBe(true);
    expect(result.coverage).toBe("none");
    expect(cleared).toBe(true);
    expect(tree.alive(patchedPid)).toBe(false);
    expect(result.host?.ppid).toBe(supervisor.pid);
    expect(result.host?.pid).toBe(gatewayPid);
  });

  test("identity attestation unloads patched Host on a supervisor-owned chain", async () => {
    const tree = new FakeProcessTree();
    const wrapper = tree.spawn("wrapper");
    const supervisor = tree.spawn("supervisor", { parent: wrapper });
    const host = tree.spawn("host", { parent: supervisor });
    const patchedPid = host.pid;
    let cleared = false;
    const result = await stopPatchedHostCoverage({
      processes: tree,
      classify: classify(tree),
      diskSha: () => "sha-reviewed",
      ephemeralRoot: await mkdtemp(join(tmpdir(), "grokbox-host-stop-")),
      waitGone: async (old) => tree.inspect(old.pid) === null,
      waitReplacement: async () => tree.spawn("host", { parent: supervisor }),
      hasGrokboxPreload: (ident) => ident.pid === patchedPid,
      readGatewayPid: () => null,
      readAttestationRecord: async () => attestationFor(host, {
        launchMode: "direct-launch",
        mode: "identity",
        modeld: false,
        profileId: undefined,
        transformedSha: undefined,
      }),
      clearAttestation: async () => {
        cleared = true;
      },
    });
    expect(result.code ?? "ok").toBe("ok");
    expect(result.ok).toBe(true);
    expect(result.signaled).toBe(true);
    expect(cleared).toBe(true);
    expect(tree.alive(patchedPid)).toBe(false);
    expect(result.host?.ppid).toBe(supervisor.pid);
  });
});
