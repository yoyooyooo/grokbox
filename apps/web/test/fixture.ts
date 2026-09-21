import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ManagementClient, CAPABILITIES } from "@grokbox/client";
import { openRuntimeStore, openMonitorStore, publishConfigFile, publishLayoutAliases, ManagementSourceError, type NativeBotSummary } from "@grokbox/box-runtime/runtime";
import { defaultConfig } from "@grokbox/runtime-kernel/config";
import { applyUse, parseModelsFile } from "@grokbox/runtime-kernel/selection";
import { startManagementServer, type ManagementNative, type AccessGrant } from "@grokbox/server";
import { ownedOwnershipReader } from "../../../packages/box-runtime/test/ownership-fixture.ts";

export const INSTALLATION = "11111111-1111-4111-8111-111111111111";
export const FIRST = "22222222-2222-4222-8222-222222222222", SECOND = "33333333-3333-4333-8333-333333333333";
export const OWNER = "synthetic-web-owner-credential", READER = "synthetic-web-reader-credential";
export const KEY_SENTINEL = "SYNTHETIC_WEB_PROVIDER_KEY";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** Synthetic native facts, real management HTTP/domain/files. No native discovery,
 * private Home, real Bot mutation, provider request or production service. */
export async function webFixture(origin: string) {
  const root = await mkdtemp(join(tmpdir(), "grokbox-web-fixture-")), store = openRuntimeStore(root, {});
  await store.saveModels(applyUse(parseModelsFile({ version: 3, models: {
    "channel/first": { provider: "openai-chat", model: "synthetic-first", endpoint: "https://provider.invalid/v1", apiKeyRef: `env:${KEY_SENTINEL}`, capabilities: { tools: true, vision: false, images: false } },
    "channel/second": { provider: "openai-responses", model: "synthetic-second", endpoint: "https://provider.invalid/v1", apiKeyRef: `env:${KEY_SENTINEL}` },
  }, assignments: { main: null, agents: {} } }), "stub/echo"));
  const bots = [FIRST, SECOND, ...Array.from({ length: 25 }, (_, i) => `44444444-4444-4444-8444-${String(i + 1).padStart(12, "0")}`)].map((id, i) => ({
    id, name: i === 0 ? "Synthetic First" : i === 1 ? "Synthetic Second" : `Synthetic ${i + 1}`, title: i === 0 ? "中文 · Unicode α" : null,
    description: i === 0 ? "A synthetic native Bot for browser qualification." : null, nativeHarness: "box", hidden: false,
    running: false, runningTurn: false, updatedAt: null, textTruncated: false, truncatedFields: [],
  })) as NativeBotSummary[];
  const state = { nativeUnavailable: false, reads: 0, ownershipReads: 0, generation: "a".repeat(64), bots,
    grants: [{ tokenSha256: hash(OWNER), principalId: "owner", capabilities: [...CAPABILITIES] },
      { tokenSha256: hash(READER), principalId: "reader", capabilities: ["bots.read", "models.read", "operations.read", "console.grants.create"] }] as AccessGrant[] };
  const ownership = ownedOwnershipReader(process.pid);
  const native: ManagementNative = {
    listBots: async () => {
      state.reads++;
      if (state.nativeUnavailable) throw new ManagementSourceError("source_unavailable");
      return { bots: structuredClone(state.bots), source: { kind: "native-gateway", generation: state.generation, pid: process.pid, startedAt: 1, observedAt: Date.now() }, coverage: "current-snapshot" };
    }, ownershipRead: async (...args) => { state.ownershipReads++; return ownership(...args); },
  };
  const observations = openMonitorStore(root);
  const options = { store, observations, installationId: INSTALLATION, native, env: {}, allowedOrigins: [origin], readGrants: async () => structuredClone(state.grants), port: 0 };
  let server = await startManagementServer(options);
  options.port = Number(new URL(server.url).port);
  const config = defaultConfig();
  config.client.profiles = { default: { serverUrl: server.url, daemonTokenRef: "env:SYNTHETIC_MANAGEMENT_CREDENTIAL", installationId: INSTALLATION } };
  config.client.currentProfile = "default";
  await publishConfigFile(join(root, "config.json"), config);
  await publishConfigFile(join(root, "state", "installation.json"), { schemaVersion: 1, installationId: INSTALLATION, role: "box", root, daemon: { tokenSha256: hash(OWNER) } });
  await publishLayoutAliases(root, root, INSTALLATION);
  return { root, store, observations, state, native, get server() { return server; },
    // These short-lived direct callers verify domain persistence across exact
    // same-port restarts. Do not carry Node's global idle socket pool from the
    // killed fixture generation into the next one. Browser transport remains
    // unchanged, and the production client still reports network failures.
    client: (credential = OWNER) => new ManagementClient({ baseUrl: server.url, installationId: INSTALLATION, credential: async () => credential,
      fetch: (async (url, init) => { const headers = new Headers(init?.headers); headers.set("connection", "close"); return fetch(url, { ...init, headers }); }) as typeof fetch }),
    restart: async () => { await server.close(); server = await startManagementServer(options); },
    close: async () => { await server.close(); await rm(root, { recursive: true, force: true }); },
  };
}
