import { expect, test } from "bun:test";
import { applyConfigChange, defaultConfig, effectiveOps, validateConfig } from "../src/config.ts";
import { canonicalJson, sha256Text } from "../src/hash.ts";
import { pairingTarget } from "../src/internal/observation/pairing-contract.ts";
import { selectNotificationTarget } from "../src/internal/observation/notification-contract.ts";

for (const preset of ["user", "maintainer"] as const) {
  test(`${preset} preset keeps read-only observation independent of notification and adoption intent`, () => {
    const config = validateConfig({ ...defaultConfig(), runtime: { desiredMode: "disabled" },
      ops: { preset, enabled: false, notifications: { mode: "off" } } });
    const ops = effectiveOps(config.ops);
    expect(ops.observation).toEqual({ enabled: true });
    expect(ops.notifications).toMatchObject({ mode: "off" });
    expect(ops.diagnostics).toEqual({ mode: "on-request" });
    expect(ops.maintenance).toEqual({ mode: "off" });
    expect(config.runtime?.desiredMode).toBe("disabled");
  });
}

test("observation changes preserve previously paired notification fingerprints", () => {
  const input = { targets: { default: { agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", routineKey: "notices" } } };
  const ops = effectiveOps(input), { observation: _, ...priorContract } = ops;
  const before = selectNotificationTarget(ops);
  expect(before.state).toBe("selected");
  if (before.state !== "selected") throw Error("fixture route unavailable");
  expect(before.target.policyRevision).toBe(sha256Text(canonicalJson(priorContract)));
  const disabled = effectiveOps({ ...input, observation: { enabled: false } });
  expect(selectNotificationTarget(disabled)).toEqual(before);
  expect(pairingTarget(disabled, "default")).toEqual(before.target);
});

test("explicit observation disable survives the canonical configuration writer without changing other policy", () => {
  const config = validateConfig({ ...defaultConfig(), ops: { preset: "maintainer", notifications: { mode: "off" } } });
  const changed = applyConfigChange(config, { kind: "set", scope: "box", operationId: "observation-off",
    path: "ops.observation.enabled", value: false, confirm: true }).document;
  expect(effectiveOps(changed.ops).observation).toEqual({ enabled: false });
  expect(changed.ops?.notifications).toEqual({ mode: "off" });
  expect(config.ops?.observation).toBeUndefined();
  for (const value of [{ enabled: "false" }, { enabled: false, authorizeAdoption: true }]) {
    expect(() => validateConfig({ ...config, ops: { ...config.ops, observation: value } })).toThrow();
  }
});
