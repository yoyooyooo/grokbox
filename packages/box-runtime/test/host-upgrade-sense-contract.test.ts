import { describe, expect, test } from "bun:test";
import {
  UPGRADE_SENSE_ADAPTER_VERSION,
  UPGRADE_SENSE_DEFAULTS,
  classifyUpgradeSense,
  parseUpgradeSenseObservation,
  type UpgradeSenseInput,
} from "../src/internal/ops/host-seam/upgrade-sense.ts";

const ENTRY_A = "a".repeat(64);
const ENTRY_B = "b".repeat(64);
const TGZ = "c".repeat(64);

describe("HSO-0 upgrade-sense contract", () => {
  test("independent fixtures distinguish rpc, ack, marker, installed SHA, and Gateway generation", () => {
    const rpc = classifyUpgradeSense({ schemaVersion: 1, rpc: { accepted: true, method: "updateHostNow", observedAt: "2026-09-10T00:00:00.000Z" } });
    const ack = classifyUpgradeSense({ schemaVersion: 1, ack: { present: true, commandId: "upgrade-bb6a405" } });
    const marker = classifyUpgradeSense({ schemaVersion: 1, marker: { kind: "applied", present: true, version: "bb6a405" } });
    const installed = classifyUpgradeSense({ schemaVersion: 1, installed: { entrySha: ENTRY_A, version: "bb6a405" } });
    const loaded = classifyUpgradeSense({
      schemaVersion: 1,
      loaded: { hostPid: 100, start: 1, gatewayPid: 200, gatewayGeneration: "gw-1", compileReceiptSha: "unknown" },
    });
    expect(new Set([rpc.sourceKind, ack.sourceKind, marker.sourceKind, installed.sourceKind, loaded.sourceKind]).size).toBe(5);
    expect([rpc, ack, marker, installed, loaded].every((row) => row.upgradeComplete === false && row.adoptEligible === false)).toBe(true);
    expect(rpc.adapterVersion).toBe(UPGRADE_SENSE_ADAPTER_VERSION);
    expect(installed.sourceSha).toBe(ENTRY_A);
    expect(rpc.sourceSha).toBeNull();
  });

  test("unknown schema, marker absence, same-version different bytes, and same-SHA new PID cannot complete or adopt", () => {
    expect(parseUpgradeSenseObservation({ schemaVersion: 99, installed: { entrySha: ENTRY_A } })).toEqual({
      ok: false,
      errorClass: "sensor_contract_changed",
    });
    const unknown = classifyUpgradeSense({ schemaVersion: 99, installed: { entrySha: ENTRY_A } });
    expect(unknown.errorClass).toBe("sensor_contract_changed");
    expect(unknown.upgradeComplete).toBe(false);
    expect(unknown.adoptEligible).toBe(false);

    const gone = classifyUpgradeSense(
      { schemaVersion: 1, marker: { present: false, kind: "applied" } },
      { schemaVersion: 1, marker: { present: true, kind: "applied", version: "bb6a405" } },
    );
    expect(gone.gaps).toContain("marker_absent_not_negative");
    expect(gone.upgradeComplete).toBe(false);
    expect(gone.adoptEligible).toBe(false);

    const mixed = classifyUpgradeSense(
      { schemaVersion: 1, advertised: { version: "bb6a405" }, installed: { entrySha: ENTRY_B, version: "bb6a405" } },
      { schemaVersion: 1, advertised: { version: "bb6a405" }, installed: { entrySha: ENTRY_A, version: "bb6a405" } },
    );
    expect(mixed.installationConsistency).toBe("mixed");
    expect(mixed.gaps).toContain("same_version_different_bytes");
    expect(mixed.upgradeComplete).toBe(false);
    expect(mixed.adoptEligible).toBe(false);

    const pid = classifyUpgradeSense(
      {
        schemaVersion: 1,
        installed: { entrySha: ENTRY_A, version: "bb6a405" },
        loaded: { hostPid: 2, start: 20, compileReceiptSha: "unknown" },
      },
      {
        schemaVersion: 1,
        installed: { entrySha: ENTRY_A, version: "bb6a405" },
        loaded: { hostPid: 1, start: 10, compileReceiptSha: "unknown" },
      },
    );
    expect(pid.gaps).toContain("same_sha_new_pid_activation_only");
    expect(pid.upgradeComplete).toBe(false);
    expect(pid.adoptEligible).toBe(false);
    expect(pid.sourceKind === "unknown" || pid.sourceKind === "installed" || pid.sourceKind === "loaded").toBe(true);
  });

  test("schema rejects raw reason/error/command/payload; defaults carry adapter version; tgz/RPC time mutants fail", () => {
    for (const key of ["reason", "error", "command", "payload"] as const) {
      expect(parseUpgradeSenseObservation({ schemaVersion: 1, [key]: "raw" })).toEqual({ ok: false, errorClass: "invalid" });
    }
    expect(UPGRADE_SENSE_DEFAULTS.adapterVersion).toBe(UPGRADE_SENSE_ADAPTER_VERSION);
    expect(UPGRADE_SENSE_DEFAULTS.deferThresholdMs.sla).toBe(false);
    expect(UPGRADE_SENSE_DEFAULTS.rollbackWatchMs.crossWriterLock).toBe(false);

    const staged: UpgradeSenseInput = {
      schemaVersion: 1,
      staged: { archiveDigest: TGZ, pending: true },
      rpc: { accepted: true, observedAt: "2026-09-10T00:00:00.000Z" },
    };
    const verdict = classifyUpgradeSense(staged);
    expect(verdict.sourceSha).not.toBe(TGZ);
    expect(verdict.sourceSha).toBeNull();
    expect(verdict.freshness.pointerFreshness).toBe("unknown");
    expect(verdict.freshness.observedAt).toBe("2026-09-10T00:00:00.000Z");
    expect(verdict.upgradeComplete).toBe(false);
    expect(verdict.adoptEligible).toBe(false);

    const pretendTgzIsSource = (input: UpgradeSenseInput) => input.staged?.archiveDigest;
    expect(pretendTgzIsSource(staged)).toBe(TGZ);
    expect(classifyUpgradeSense(staged).sourceSha).not.toBe(pretendTgzIsSource(staged));

    const pretendRpcTimeIsPointer = (input: UpgradeSenseInput) => input.rpc?.observedAt;
    expect(pretendRpcTimeIsPointer(staged)).toBe("2026-09-10T00:00:00.000Z");
    expect(classifyUpgradeSense(staged).freshness.pointerFreshness).not.toBe("fresh");
  });
});
