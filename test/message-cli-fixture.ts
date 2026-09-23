import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAPABILITIES } from "@grokbox/client";
import { defaultConfig } from "@grokbox/runtime-kernel/config";
import { openRuntimeStore, createManagementGateway, publishConfigFile, publishLayoutAliases } from "@grokbox/box-runtime/runtime";
import { startManagementServer } from "../packages/server/src/server.ts";
import { ownedOwnershipSnapshot } from "../packages/box-runtime/test/ownership-fixture.ts";
import { captureCli, startMockGateway, type MockOptions } from "./helpers.ts";
export const MESSAGE_BOT = "11111111-1111-4111-8111-111111111111";
export const MESSAGE_OTHER = "22222222-2222-4222-8222-222222222222";
export const MESSAGE_INSTALLATION = "33333333-3333-4333-8333-333333333333";
const NONCE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/** Real CLI -> shared client -> HTTP Server -> existing native HTTP adapter.
 * Only the native Gateway is synthetic; no old daemon writer is substituted. */
export async function captureMessageCli(argv: string[], options: MockOptions & { stdinIsTTY?: boolean; stdin?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "message-cli-"));
  const credential = "owned-management-credential";
  const gateway = await startMockGateway({ ...options,
    agents: options.agents ?? [{ id: MESSAGE_BOT, name: "alpha", title: "Alpha", harness: "box", isGroup: false }],
    tail: options.tail ?? { entries: [{ id: "e1", kind: "message", role: "user", content: "deployment", requestId: "native-id", timestampMs: 1 }], nextBeforeSeq: 9 },
    sendPrompt: options.sendPrompt ?? (() => ({ status: 200, body: { accepted: true } })),
    hostStatus: (input: { grokboxOwnershipAgentIds?: string[] }) => ({ grokboxOwnership: ownedOwnershipSnapshot(input.grokboxOwnershipAgentIds ?? []) }),
  });
  let server: Awaited<ReturnType<typeof startManagementServer>> | undefined;
  try {
    const discoveryPath = join(root, "owned-gateway.json");
    await publishConfigFile(discoveryPath, { scheme: "http", host: "127.0.0.1", port: gateway.port, token: gateway.token, pid: gateway.pid, startedAt: gateway.startedAt });
    const native = createManagementGateway({ discoveryPath, configurationRoot: root });
    const store = openRuntimeStore(root, {});
    server = await startManagementServer({ store, installationId: MESSAGE_INSTALLATION, native,
      readGrants: async () => [{ principalId: "owned", tokenSha256: createHash("sha256").update(credential).digest("hex"), capabilities: [...CAPABILITIES] }] }, { hostHealth: { enabled: false } });
    const config = defaultConfig();
    config.client.profiles.default = { serverUrl: server.url, daemonTokenRef: "env:OWNED_MANAGEMENT_TOKEN" };
    await publishConfigFile(join(root, "config.json"), config);
    await publishConfigFile(join(root, "state/installation.json"), { schemaVersion: 1, installationId: MESSAGE_INSTALLATION, role: "box", root });
    await publishLayoutAliases(root, root, MESSAGE_INSTALLATION);
    let stdinReads = 0;
    const result = await captureCli(argv, { configDir: root, boxRuntimeRoot: root, discoveryPath: "/must-not-dial-from-cli", env: { OWNED_MANAGEMENT_TOKEN: credential },
      stdinIsTTY: options.stdinIsTTY ?? true, readStdin: async () => { stdinReads++; return options.stdin ?? ""; }, randomUUID: () => NONCE });
    return { ...result, mock: gateway, stdinReads };
  } finally { await server?.close(); gateway.stop(); await rm(root, { recursive: true, force: true }); }
}
