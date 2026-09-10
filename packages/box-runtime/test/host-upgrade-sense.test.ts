import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyUpgradeSense,
  type UpgradeSenseInput,
} from "../src/internal/ops/host-seam/upgrade-sense.ts";
import {
  assertNoUpgradeRpc,
  HOST_UPGRADE_RPC_FORBIDDEN,
  readOnlyHostStatus,
} from "../src/internal/ops/host-seam/gateway-readonly.ts";
import { hostBundlesDir } from "../src/internal/io/paths.ts";

const ENTRY = "a".repeat(64);

type SimKind =
  | "idle_auto"
  | "force_rpc"
  | "boot_fetch"
  | "entry_first_version_last"
  | "mutated_fail"
  | "applied_crash_rollback"
  | "ack_veto"
  | "supervisor_restart"
  | "unattributed_write";

function simulate(kind: SimKind): { observation: UpgradeSenseInput; simulatorWrites: number } {
  switch (kind) {
    case "idle_auto":
      return { simulatorWrites: 1, observation: { schemaVersion: 1, rpc: { accepted: true, method: "idle-auto-update" } } };
    case "force_rpc":
      return { simulatorWrites: 1, observation: { schemaVersion: 1, rpc: { accepted: true, method: "updateHostNow" } } };
    case "boot_fetch":
      return {
        simulatorWrites: 1,
        observation: { schemaVersion: 1, installed: { entrySha: ENTRY, version: "bb6a405" }, staged: { pending: false } },
      };
    case "entry_first_version_last":
      return {
        simulatorWrites: 2,
        observation: {
          schemaVersion: 1,
          staged: { pending: true, archiveDigest: "c".repeat(64) },
          installed: { entrySha: ENTRY },
        },
      };
    case "mutated_fail":
      return {
        simulatorWrites: 1,
        observation: { schemaVersion: 1, marker: { kind: "failed", present: true, version: "bb6a405" } },
      };
    case "applied_crash_rollback":
      return {
        simulatorWrites: 2,
        observation: {
          schemaVersion: 1,
          marker: { kind: "applied", present: true, version: "bb6a405" },
          loaded: { hostPid: 9, start: 1, compileReceiptSha: "unknown" },
        },
      };
    case "ack_veto":
      return { simulatorWrites: 1, observation: { schemaVersion: 1, ack: { present: true, commandId: "upgrade-bb6a405" } } };
    case "supervisor_restart":
      return {
        simulatorWrites: 1,
        observation: {
          schemaVersion: 1,
          installed: { entrySha: ENTRY },
          loaded: { hostPid: 11, start: 2, compileReceiptSha: "unknown" },
        },
      };
    case "unattributed_write":
      return { simulatorWrites: 1, observation: { schemaVersion: 1, installed: { entrySha: "d".repeat(64) } } };
    default: {
      const _never: never = kind;
      return _never;
    }
  }
}

describe("HSO-1 upgrade-sense simulator and read-only Gateway", () => {
  test("each upstream kind classifies without ops corpus writes or adopt", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokbox-hso1-sim-"));
    await mkdir(hostBundlesDir(root), { recursive: true });
    const kinds: SimKind[] = [
      "idle_auto",
      "force_rpc",
      "boot_fetch",
      "entry_first_version_last",
      "mutated_fail",
      "applied_crash_rollback",
      "ack_veto",
      "supervisor_restart",
      "unattributed_write",
    ];
    let simulatorWrites = 0;
    const seen = new Set<string>();
    for (const kind of kinds) {
      const sim = simulate(kind);
      simulatorWrites += sim.simulatorWrites;
      const verdict = classifyUpgradeSense(sim.observation);
      seen.add(`${kind}:${verdict.sourceKind}:${verdict.installationConsistency}`);
      expect(verdict.upgradeComplete).toBe(false);
      expect(verdict.adoptEligible).toBe(false);
      expect(verdict.sourceSha === null || verdict.sourceSha !== sim.observation.staged?.archiveDigest).toBe(true);
    }
    expect(seen.size).toBe(kinds.length);
    expect(simulatorWrites).toBeGreaterThan(0);
    expect(await readdir(hostBundlesDir(root))).toEqual([]);
  });

  test("read-only Gateway can getHostStatus and forbids upgrade RPCs", async () => {
    const calls: string[] = [];
    const fake = {
      getHostStatus: async () => {
        calls.push("getHostStatus");
        return { hostVersion: "bb6a405" };
      },
      updateHostNow: async () => {
        calls.push("updateHostNow");
      },
      autoUpdateBoxNow: async () => {
        calls.push("autoUpdateBoxNow");
      },
    };
    const ro = readOnlyHostStatus(fake);
    expect(await ro.getHostStatus()).toEqual({ hostVersion: "bb6a405" });
    expect(calls).toEqual(["getHostStatus"]);
    expect("updateHostNow" in ro).toBe(false);
    expect("autoUpdateBoxNow" in ro).toBe(false);
    for (const method of HOST_UPGRADE_RPC_FORBIDDEN) {
      expect(() => assertNoUpgradeRpc(method)).toThrow(/forbids/);
    }
  });
});
