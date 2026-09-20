import { createServer } from "node:http";
import { join } from "node:path";
import { createManagementGateway, publishConfigFile } from "@grokbox/box-runtime/runtime";
import { ownedOwnershipSnapshot } from "../../box-runtime/test/ownership-fixture.ts";

export type NativeMode = "box" | "conflict" | "temporal" | "old" | "failure" | "wrong-id";
export const CATALOG_CREDENTIAL = "synthetic-model-catalog-credential";
const TOKEN = "synthetic-native-gateway-credential";

/** Actual loopback HTTP and protected discovery; all native/catalog facts are synthetic. */
export async function nativeFixture(root: string, mode: NativeMode, botId: string, otherId: string) {
  const calls: string[] = [];
  const server = createServer(async (request, response) => {
    calls.push(request.url ?? "");
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/models") {
      if (request.headers.authorization !== `Bearer ${CATALOG_CREDENTIAL}`) { response.writeHead(401).end("{}"); return; }
      response.end(JSON.stringify({ data: [{ id: "first" }] })); return;
    }
    if (request.headers.authorization !== `Bearer ${TOKEN}`) { response.writeHead(401).end("{}"); return; }
    let text = "";
    for await (const chunk of request) text += chunk.toString();
    const input = JSON.parse(text || "{}");
    if (request.url === "/api/listAgents") {
      response.end(JSON.stringify([{ id: botId, name: "First", title: "User title", harness: "box" }, { id: otherId, name: "Second", harness: "box" }])); return;
    }
    if (request.url === "/api/getHostStatus") {
      if (mode === "failure") { response.writeHead(503).end("{}"); return; }
      if (mode === "old") { response.end("{}"); return; }
      response.end(JSON.stringify({ grokboxOwnership: ownedOwnershipSnapshot(mode === "wrong-id" ? [otherId] : input.grokboxOwnershipAgentIds, {
        serverHarness: mode === "conflict" || mode === "temporal" ? "temporal" : "box",
        localHarness: mode === "temporal" ? "temporal" : "box",
      }) })); return;
    }
    response.writeHead(404).end("{}");
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const close = () => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
  try {
    const address = server.address(); if (!address || typeof address === "string") throw new Error("native-fixture-address");
    const discoveryPath = join(root, "native-discovery.json");
    await publishConfigFile(discoveryPath, { scheme: "http", host: "127.0.0.1", port: address.port, pid: process.pid, startedAt: 1, token: TOKEN });
    return { native: createManagementGateway({ discoveryPath }), endpoint: `http://127.0.0.1:${address.port}/v1`, calls, close };
  } catch (error) { await close(); throw error; }
}
