import { createHash } from "node:crypto";
import { join } from "node:path";
import { CAPABILITIES, ManagementClient } from "@grokbox/client";
import { openRuntimeStore, publishConfigFile, publishLayoutAliases } from "@grokbox/box-runtime/runtime";
import { startManagementServer, type ManagementNative, type AccessGrant } from "@grokbox/server";
import { automaticFixture, MODEL } from "../../../packages/box-runtime/test/fixtures/automatic-notice.ts";

export const RECEIVER_INSTALLATION = "11111111-1111-4111-8111-111111111111";
export const RECEIVER_OWNER = "synthetic-receiver-owner", RECEIVER_READER = "synthetic-receiver-reader", RECEIVER_TESTER = "synthetic-receiver-tester";
export { MODEL as RECEIVER_MODEL };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
/** Private fixture with no real Bot/provider: real management HTTP, SQLite,
 * private credential capsule and a loopback-only notification transport. No
 * incident or test delivery is seeded before the caller explicitly requests it. */
export async function receiverFixture(origin: string, budget = 10) {
  const f = await automaticFixture(budget);
  const state = { unexpectedReads: 0, grants: [
    { principalId: "owner", tokenSha256: digest(RECEIVER_OWNER), capabilities: [...CAPABILITIES] },
    { principalId: "reader", tokenSha256: digest(RECEIVER_READER), capabilities: ["notifications.read", "operations.read", "console.grants.create"] },
    { principalId: "tester", tokenSha256: digest(RECEIVER_TESTER), capabilities: ["notifications.read", "notifications.test", "operations.read", "console.grants.create"] },
  ] as AccessGrant[] };
  const native: ManagementNative = {
    listBots: async () => { state.unexpectedReads++; throw Error("synthetic_receiver_roster_not_configured"); },
    ownershipRead: async () => { state.unexpectedReads++; throw Error("synthetic_receiver_collector_not_configured"); },
    readNotificationReceiver: (agentId, routineId, signal) => { signal?.throwIfAborted(); return f.readNative(); },
  };
  const options = { store: openRuntimeStore(f.root, {}), installationId: RECEIVER_INSTALLATION, native, observations: f.store,
    allowedOrigins: [origin], readGrants: async () => structuredClone(state.grants), env: {}, port: 0 };
  // This isolated receiver fixture does not authorize reads of the machine's
  // real Host artifacts. Host-health integration has its own real-binary fixture.
  const ports = { hostHealth:{enabled:false}, notification: { request: f.request, idleMs: 10, blockedMs: 10 } };
  let server = await startManagementServer(options, ports);
  options.port = Number(new URL(server.url).port);
  const config = structuredClone(f.document);
  config.client.currentProfile = "default";
  config.client.profiles = { default: { serverUrl: server.url, daemonTokenRef: "env:SYNTHETIC_RECEIVER_CREDENTIAL", installationId: RECEIVER_INSTALLATION } };
  await publishConfigFile(join(f.root, "config.json"), config);
  await publishConfigFile(join(f.root, "state", "installation.json"), { schemaVersion: 1, installationId: RECEIVER_INSTALLATION, role: "box", root: f.root,
    daemon: { tokenSha256: digest(RECEIVER_OWNER) } });
  await publishLayoutAliases(f.root, f.root, RECEIVER_INSTALLATION);
  const databaseId = (await f.store.notificationScope()).databaseId;
  const ref = `receiver:${RECEIVER_INSTALLATION}:${databaseId}:${f.pairing.bindingId}`;
  return { ...f, ref, databaseId, state, native, config, get server() { return server; },
    client: (credential = RECEIVER_OWNER) => new ManagementClient({ baseUrl: server.url, installationId: RECEIVER_INSTALLATION, credential: async () => credential }),
    restart: async () => { await server.close(); server = await startManagementServer(options, ports); },
    close: async () => { await server.close(); await f.close(); },
  };
}
