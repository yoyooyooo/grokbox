import { expect, test } from "bun:test";
import { defaultConfig, migrateConfigV2, migrateConfigV3, validateConfig, type DaemonIntent } from "../src/config.ts";

const network = { host: "127.0.0.1", port: 4317 } satisfies NonNullable<DaemonIntent["network"]>;
const serve = { httpsPort: 443, dnsName: "box.example.invalid", proxyUrl: "http://127.0.0.1:4317" };

for (const [schemaVersion, migrate] of [[2, migrateConfigV2], [3, migrateConfigV3]] as const) {
  test(`explicit v${schemaVersion} migration retires validated Serve metadata without changing connection intent`, () => {
    const old = { ...defaultConfig(), schemaVersion, daemon: { network, serve } };
    const before = JSON.stringify(old);
    const current = migrate(old);
    expect(current).toEqual({ ...defaultConfig(), daemon: { network } });
    expect(JSON.stringify(old)).toBe(before);
    expect(() => validateConfig({ ...current, daemon: old.daemon })).toThrow();
  });

  test(`v${schemaVersion} migration refuses unknown or invalid retired Serve data before discarding it`, () => {
    for (const daemon of [
      { network, serve: { ...serve, unknown: "preserve-me" } },
      { network, serve: { httpsPort: 443, dnsName: serve.dnsName } },
      { network, serve: { ...serve, httpsPort: 0 } },
      { network, serve: { ...serve, proxyUrl: "http://127.0.0.1:4318" } },
      { network, serve: { ...serve, proxyUrl: "https://user:secret@example.invalid" } },
      { network, serve: null },
      { serve },
      { network, serve, unknown: true },
    ]) {
      const old = { ...defaultConfig(), schemaVersion, daemon };
      const before = JSON.stringify(old);
      expect(() => migrate(old)).toThrow();
      expect(JSON.stringify(old)).toBe(before);
    }
  });
}
