import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventsPath } from "../src/internal/io/paths.ts";
import { observeAndHeal } from "../src/internal/process/watchdog.ts";
import { SYNTHETIC_HOST } from "./synthetic-host.ts";
import { FakeProcessTree } from "./fake-tree.ts";

describe("watchdog observe and stale-patched heal", () => {
  test("SHA change snapshots slices, opens circuit, and TERMs only the attested host once", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokbox-watchdog-"));
    const tree = new FakeProcessTree();
    const wrapper = tree.spawn("wrapper");
    const supervisor = tree.spawn("supervisor");
    const host = tree.spawn("host");
    void wrapper;
    void supervisor;

    const first = await observeAndHeal({
      root,
      disk: { source: SYNTHETIC_HOST },
      processes: tree,
      host,
      attestation: {
        pid: host.pid,
        start: host.start,
        sourceSha: "not-yet",
        identity: host,
      },
      now: () => "2026-01-01T00:00:00.000Z",
    });
    expect(first.result.injected).toBe(false);
    expect(first.result.coverage).toBe("window-open");
    expect(first.result.reason).toBe("unsupported_bundle");
    expect(first.result.circuit).toBe("open");
    expect(tree.signals.filter((row) => row.signal === "SIGTERM")).toHaveLength(1);
    expect(tree.alive(host.pid)).toBe(false);

    const extra = tree.spawn("extra");
    const secondSource = SYNTHETIC_HOST.replace("official-main", "official-main-v2");
    let relaunch = 0;
    const second = await observeAndHeal({
      root,
      disk: { source: secondSource },
      processes: tree,
      host: extra,
      attestation: null,
      now: () => "2026-01-01T00:00:01.000Z",
      relaunchUnpatched: () => {
        relaunch += 1;
        tree.spawn("host");
      },
    });
    expect(second.result.injected).toBe(false);
    expect(second.result.driftedSlices.length).toBeGreaterThan(0);
    expect(tree.signals.filter((row) => row.signal === "SIGTERM")).toHaveLength(1);
    expect(tree.alive(extra.pid)).toBe(true);
    expect(relaunch).toBe(0);

    const generations = await readdir(join(root, "contracts", "generations"));
    expect(generations).toHaveLength(2);
    const bundles = await readdir(join(root, "host-bundles", "generations"));
    expect(bundles).toHaveLength(2);
    const head = (await readFile(join(root, "contracts", "HEAD"), "utf8")).trim();
    expect(head.length).toBe(64);
    const events = (await readFile(eventsPath(root), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as { name: string });
    const names = events.map((event) => event.name);
    expect(names).toContain("disk_sha_observed");
    expect(names).toContain("contracts_snapshot");
    expect(names).toContain("attestation_invalidated");
    expect(names).toContain("stale_patched_detected");
    expect(names).toContain("stale_patched_term");
    expect(names).toContain("circuit_open");
    expect(JSON.stringify(events)).not.toMatch(/token|prompt|ACME|secret/i);
    expect(tree.signals.every((row) => row.exe.startsWith("/fake/"))).toBe(true);
  });

  test("unrecognized extra processes are never signaled and TERM is not retried after failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokbox-watchdog-"));
    const tree = new FakeProcessTree();
    const host = tree.spawn("host");
    const extra = tree.spawn("extra");
    const staleIdentity = { ...host, exe: "/fake/wrong-host" };
    const once = await observeAndHeal({
      root,
      disk: { source: SYNTHETIC_HOST },
      processes: tree,
      host,
      attestation: {
        pid: host.pid,
        start: host.start,
        sourceSha: "old",
        identity: staleIdentity,
      },
      now: () => "2026-01-01T00:00:00.000Z",
    });
    expect(once.result.lastHeal).toEqual({ outcome: "failed" });
    expect(tree.alive(host.pid)).toBe(true);
    expect(tree.alive(extra.pid)).toBe(true);
    expect(tree.signals.filter((row) => row.pid === extra.pid)).toEqual([]);
    const again = await observeAndHeal({
      root,
      disk: { source: SYNTHETIC_HOST },
      processes: tree,
      host,
      attestation: null,
      now: () => "2026-01-01T00:00:02.000Z",
    });
    expect(again.result.injected).toBe(false);
    expect(tree.signals.filter((row) => row.signal === "SIGTERM")).toHaveLength(0);
  });
});
