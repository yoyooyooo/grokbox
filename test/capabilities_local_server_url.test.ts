import { beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { writeProfileFile } from "../src/config/profile.ts";
import { captureCli, parseJson } from "./helpers.ts";

const skillsDir = join(import.meta.dir, "..", "skills");
const SERVER_URL = "https://my-daemon.example.test";
const DAEMON_TOKEN_REF = "file:/tmp/token";

type CapabilitiesBody = {
  data: {
    profile: string;
    transport: string;
    connection: {
      endpoint: string | null;
      protocolMajor: number | null;
      credentialReference: string | null;
      credentialConfigured: boolean;
      gatewayGeneration: string;
    };
    capabilities: Record<string, boolean | string>;
  };
};

let body: CapabilitiesBody;

beforeAll(async () => {
  const configDir = await mkdtemp(join(tmpdir(), "grokbox-cap-local-"));
  await writeProfileFile(configDir, "stray", {
    version: 1,
    transport: "local",
    server_url: SERVER_URL,
    daemon_token_ref: DAEMON_TOKEN_REF,
  });
  const result = await captureCli(["profile", "capabilities", "stray"], {
    configDir,
    env: {},
    discoveryPath: "/missing/gateway.json",
    skillsDir,
    runCommand: async () => ({ code: 127, stdout: "", stderr: "not configured" }),
  });
  expect(result.code).toBe(0);
  body = parseJson(result.stdout) as CapabilitiesBody;
});

describe("profile capabilities local+server_url misclassification", () => {
  test("transport is reported as local", () => {
    expect(body.data.transport).toBe("local");
  });

  test("connection.endpoint is not the stray server_url", () => {
    expect(body.data.connection.endpoint).not.toBe(SERVER_URL);
  });

  test("connection.endpoint falls back to the gateway discovery path", () => {
    expect(body.data.connection.endpoint).toBe("/missing/gateway.json");
  });

  test("connection.protocolMajor is null", () => {
    expect(body.data.connection.protocolMajor).toBe(null);
  });

  test("connection.credentialReference is null (gateway token absent)", () => {
    expect(body.data.connection.credentialReference).toBe(null);
  });

  test("connection.credentialConfigured is false (gateway token absent)", () => {
    expect(body.data.connection.credentialConfigured).toBe(false);
  });

  test("host.fs.read is false", () => {
    expect(body.data.capabilities["host.fs.read"]).toBe(false);
  });

  test("host.fs.write is false", () => {
    expect(body.data.capabilities["host.fs.write"]).toBe(false);
  });

  test("host.process.run is false", () => {
    expect(body.data.capabilities["host.process.run"]).toBe(false);
  });

  test("host.process.manage is false", () => {
    expect(body.data.capabilities["host.process.manage"]).toBe(false);
  });

  test("host.process.shell is false", () => {
    expect(body.data.capabilities["host.process.shell"]).toBe(false);
  });

  test("host.desktop.read is false", () => {
    expect(body.data.capabilities["host.desktop.read"]).toBe(false);
  });

  test("host.desktop.reap is false", () => {
    expect(body.data.capabilities["host.desktop.reap"]).toBe(false);
  });

  test("grok.* capabilities remain available through the local gateway", () => {
    expect(body.data.capabilities["grok.roster.read"]).toBe(true);
    expect(body.data.capabilities["grok.transcript.read"]).toBe(true);
    expect(body.data.capabilities["grok.transcript.write"]).toBe(true);
  });
});
