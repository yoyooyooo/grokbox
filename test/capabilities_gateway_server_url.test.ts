import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { writeProfileFile } from "../src/config/profile.ts";
import { captureCli, parseJson } from "./helpers.ts";

const skillsDir = join(import.meta.dir, "..", "skills");
const GATEWAY_URL = "https://gateway.example.test";
const SERVER_URL = "https://my-daemon.example.test";

describe("profile capabilities gateway+server_url misclassification", () => {
  test("gateway transport with stray server_url reports gateway-derived capabilities", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "grokbox-cap-gateway-"));
    await writeProfileFile(configDir, "gw", {
      version: 1,
      transport: "gateway",
      gateway_url: GATEWAY_URL,
      server_url: SERVER_URL,
      daemon_token_ref: "file:/tmp/token",
    });
    const result = await captureCli(["profile", "capabilities", "gw"], {
      configDir,
      env: {},
      discoveryPath: "/missing/gateway.json",
      skillsDir,
      runCommand: async () => ({ code: 127, stdout: "", stderr: "not configured" }),
    });
    expect(result.code).toBe(0);
    const body = parseJson(result.stdout) as {
      data: {
        connection: { endpoint: string | null; protocolMajor: number | null };
        capabilities: Record<string, boolean | string>;
      };
    };
    expect(body.data.connection.protocolMajor).toBe(null);
    expect(body.data.capabilities["host.fs.read"]).toBe(false);
    expect(body.data.connection.endpoint).toBe(GATEWAY_URL);
    expect(body.data.connection.endpoint).not.toBe(SERVER_URL);
  });
});
