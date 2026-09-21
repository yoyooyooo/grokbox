import { describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import {
  resolveProfile,
  writeGlobalConfig,
  writeProfileFile,
} from "../packages/cli/src/config/profile.ts";
import {
  resolveSecretRef,
  retireOwnedFileSecret,
  validateSecretFileStat,
} from "../packages/cli/src/config/secret.ts";
import { captureCli, parseJson } from "./helpers.ts";

const skillsDir = join(import.meta.dir, "..", "skills");

async function makeConfigDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "grokbox-profile-test-"));
}

async function cli(
  configDir: string,
  argv: string[],
  overrides: Partial<Parameters<typeof captureCli>[1]> = {},
) {
  return await captureCli(argv, {
    configDir,
    env: {},
    discoveryPath: "/missing/gateway.json",
    skillsDir,
    runCommand: async () => ({ code: 127, stdout: "", stderr: "not configured" }),
    ...overrides,
  });
}

function code(stderr: string): string {
  return (parseJson(stderr) as { error: { code: string } }).error.code;
}

describe("Profiles in unified config v2",  () => {
  test("default is synthesized and selection precedence is deterministic", async () => {
    const configDir = await makeConfigDir();
    await writeProfileFile(configDir, "remote", { version: 1, gateway_discovery: "/remote/gateway.json" });
    await writeProfileFile(configDir, "saved", { version: 1, gateway_discovery: "/saved/gateway.json" });
    await writeGlobalConfig(configDir, { version: 1, current_profile: "saved" });

    const saved = await resolveProfile({ configDir, env: {}, discoveryPath: "/default/gateway.json" });
    expect(saved.name).toBe("saved");
    expect(saved.gateway_discovery).toBe("/saved/gateway.json");

    const env = await resolveProfile({
      configDir,
      env: { GROKBOX_PROFILE: "remote" },
      discoveryPath: "/default/gateway.json",
    });
    expect(env.name).toBe("remote");

    const explicit = await resolveProfile(
      { configDir, env: { GROKBOX_PROFILE: "remote" }, discoveryPath: "/default/gateway.json" },
      "default",
    );
    expect(explicit.name).toBe("default");
    expect(explicit.gateway_discovery).toBe("/default/gateway.json");
  });

  test("CRUD is strict, atomic, permissioned, and protects default", async () => {
    const configDir = await makeConfigDir();
    const added = await cli(configDir, [
      "profile",
      "add",
      "remote",
      "--transport",
      "daemon",
      "--server-url",
      "https://remote.example.ts.net",
      "--daemon-token-ref",
      "file:/tmp/daemon-token",
      "--sandbox-access-token-ref",
      "env:CURSOR_ACCESS_TOKEN",
      "--quota-source",
      "cursor-web",
      "--quota-access-token-ref",
      "keychain:grokbox/quota",
    ]);
    expect(added.code).toBe(0);

    const profilePath = join(configDir, "config.json");
    expect((await stat(configDir)).mode & 0o777).toBe(0o700);
    expect(await stat(join(configDir, "profiles")).catch((error: NodeJS.ErrnoException) => error.code)).toBe("ENOENT");
    expect((await stat(profilePath)).mode & 0o777).toBe(0o600);
    const document = JSON.parse(await readFile(profilePath, "utf8"));
    expect(document.schemaVersion).toBe(4);
    const persisted = document.client.profiles.remote;
    expect(persisted.daemonTokenRef).toBe("file:/tmp/daemon-token");
    expect(persisted.quota).toEqual({
      source: "cursor-web",
      accessTokenRef: "keychain:grokbox/quota",
    });
    expect(JSON.stringify(persisted)).not.toContain("CURSOR_ACCESS_TOKEN=");

    const updated = await cli(configDir, ["profile", "update", "remote", "--ssh-host", "remote"]);
    expect(updated.code).toBe(0);
    const shown = await cli(configDir, ["profile", "show", "remote"]);
    const shownBody = parseJson(shown.stdout) as { data: { profile: { ssh_host: string } } };
    expect(shownBody.data.profile.ssh_host).toBe("remote");

    const used = await cli(configDir, ["profile", "use", "remote"]);
    expect(used.code).toBe(0);
    const listed = await cli(configDir, ["profile", "list"]);
    const listBody = parseJson(listed.stdout) as {
      data: { current: string; profiles: Array<{ name: string; current: boolean }> };
    };
    expect(listBody.data.current).toBe("remote");
    expect(listBody.data.profiles.find((profile) => profile.name === "remote")?.current).toBe(true);

    const protectedDefault = await cli(configDir, ["profile", "remove", "default"]);
    expect(protectedDefault.code).toBe(21);
    expect(code(protectedDefault.stderr)).toBe("profile_invalid");

    const removed = await cli(configDir, ["profile", "remove", "remote"]);
    expect(removed.code).toBe(0);
    const global = JSON.parse(await readFile(join(configDir, "config.json"), "utf8"));
    expect(global.client.currentProfile).toBe("default");
  });

  test("manual secret fallback consumes non-TTY stdin into a 0600 file without echo", async () => {
    const configDir = await makeConfigDir();
    const secretPath = join(configDir, "secrets", "daemon");
    let reads = 0;
    const result = await cli(
      configDir,
      ["profile", "add", "remote", "--secret-stdin-file", `daemon-token=${secretPath}`],
      {
        stdinIsTTY: false,
        readStdin: async () => {
          reads += 1;
          return "manual-secret-value\n";
        },
      },
    );
    expect(result.code).toBe(0);
    expect(reads).toBe(1);
    expect(result.stdout).not.toContain("manual-secret-value");
    expect(result.stderr).not.toContain("manual-secret-value");
    expect(await readFile(secretPath, "utf8")).toBe("manual-secret-value");
    expect((await stat(secretPath)).mode & 0o777).toBe(0o600);
    const persisted = JSON.parse(await readFile(join(configDir, "config.json"), "utf8")).client.profiles.remote;
    expect(persisted.daemonTokenRef).toBe(`file:${secretPath}`);
  });

  test("quota secret stdin requires an explicit source and writes one protected reference", async () => {
    const configDir = await makeConfigDir();
    const secretPath = join(configDir, "secrets", "quota");
    const result = await cli(
      configDir,
      [
        "profile",
        "add",
        "quota",
        "--quota-source",
        "cursor-web",
        "--secret-stdin-file",
        `quota-access-token=${secretPath}`,
      ],
      { stdinIsTTY: false, readStdin: async () => "quota-secret\n" },
    );
    expect(result.code).toBe(0);
    expect(await readFile(secretPath, "utf8")).toBe("quota-secret");
    expect((await stat(secretPath)).mode & 0o777).toBe(0o600);
    const persisted = JSON.parse(await readFile(join(configDir, "config.json"), "utf8")).client.profiles.quota;
    expect(persisted.quota).toEqual({ source: "cursor-web", accessTokenRef: `file:${secretPath}` });
    expect(result.stdout + result.stderr).not.toContain("quota-secret");

    const missingSource = await cli(
      await makeConfigDir(),
      ["profile", "add", "bad-quota", "--quota-access-token-ref", "env:QUOTA_TOKEN"],
    );
    expect(missingSource.code).toBe(2);
    expect(code(missingSource.stderr)).toBe("invalid_usage");
  });

  test("secret references resolve by purpose without exposing values in failures", async () => {
    const configDir = await makeConfigDir();
    const secretPath = join(configDir, "credential");
    await writeFile(secretPath, "file-secret\n", { mode: 0o600 });
    const base = {
      env: { TOKEN: "env-secret" },
      readFile: async (path: string) => await readFile(path, "utf8"),
      runCommand: async () => ({ code: 0, stdout: "keychain-secret\n", stderr: "" }),
    };
    expect(await resolveSecretRef(base, "env:TOKEN")).toBe("env-secret");
    expect(await resolveSecretRef(base, `file:${secretPath}`)).toBe("file-secret");
    expect(await resolveSecretRef(base, "keychain:grokbox/account")).toBe("keychain-secret");

    const unavailable = resolveSecretRef({ ...base, env: {} }, "env:MISSING");
    expect(unavailable).rejects.toMatchObject({ code: "credential_unavailable" });
    expect(String(await unavailable.catch((error: Error) => error.message))).not.toContain("MISSING");

    const oldPath = join(configDir, "secrets", "old");
    const currentPath = join(configDir, "secrets", "current");
    await mkdir(join(configDir, "secrets"), { recursive: true });
    await writeFile(oldPath, "old-raw-secret", { mode: 0o600 });
    await writeFile(currentPath, "current-secret", { mode: 0o600 });
    await retireOwnedFileSecret(configDir, `file:${oldPath}`, `file:${currentPath}`);
    expect(await readFile(oldPath, "utf8")).toBe("revoked");
    expect(await readFile(currentPath, "utf8")).toBe("current-secret");
  });

  test("file secret references require a current-user regular file with private permissions", async () => {
    const configDir = await makeConfigDir();
    const base = {
      env: {},
      readFile: async (path: string) => await readFile(path, "utf8"),
      runCommand: async () => ({ code: 127, stdout: "", stderr: "not configured" }),
    };
    const publicPath = join(configDir, "public-secret");
    await writeFile(publicPath, "secret", { mode: 0o600 });
    await chmod(publicPath, 0o640);
    await expect(resolveSecretRef(base, `file:${publicPath}`)).rejects.toMatchObject({
      code: "credential_invalid",
    });

    const privatePath = join(configDir, "private-secret");
    const symlinkPath = join(configDir, "secret-link");
    await writeFile(privatePath, "secret", { mode: 0o600 });
    await symlink(privatePath, symlinkPath);
    await expect(resolveSecretRef(base, `file:${symlinkPath}`)).rejects.toMatchObject({
      code: "credential_invalid",
    });

    expect(() => validateSecretFileStat({ mode: 0o100600, uid: 42, isFile: () => true }, 7))
      .toThrow("must be owned by the current user");
    expect(() => validateSecretFileStat({ mode: 0o040700, uid: 7, isFile: () => false }, 7))
      .toThrow("must be a regular file");
    expect(() => validateSecretFileStat({ mode: 0o100600, uid: 7, isFile: () => true }, Number.NaN))
      .toThrow("cannot be verified on this platform");
  });

  test("unknown fields and inline tokens fail before any secret read", async () => {
    const configDir = await makeConfigDir();
    await writeFile(join(configDir, "config.json"), JSON.stringify({ schemaVersion: 4, client: {
      currentProfile: "default", profiles: { default: { transport: "auto" }, bad: { daemon_token: "raw-secret", daemonTokenRef: "file:/missing" } },
    } }), { mode: 0o600 });
    const result = await cli(configDir, ["profile", "show", "bad"]);
    expect(result.code).toBe(73);
    expect(code(result.stderr)).toBe("config_invalid");
    expect(result.stderr).not.toContain("raw-secret");
    expect(result.stderr).not.toContain("/missing");
    await writeFile(join(configDir, "config.json"), JSON.stringify({ schemaVersion: 4, client: {
      currentProfile: "default", profiles: { default: { transport: "auto" } },
    } }), { mode: 0o600 });

    const inline = await cli(configDir, ["profile", "add", "inline", "--daemon-token-ref", "secret"]);
    expect(inline.code).toBe(21);
    expect(code(inline.stderr)).toBe("profile_invalid");

    const urlSecret = await cli(configDir, [
      "profile",
      "add",
      "url-secret",
      "--server-url",
      "https://inline-secret@example.test/path?token=hidden",
    ]);
    expect(urlSecret.code).toBe(21);
    expect(code(urlSecret.stderr)).toBe("profile_invalid");
    expect(urlSecret.stderr).not.toContain("inline-secret");
    expect(urlSecret.stderr).not.toContain("hidden");

    const plainRemote = await cli(configDir, [
      "profile",
      "add",
      "plain-remote",
      "--server-url",
      "http://remote.example.test",
    ]);
    expect(plainRemote.code).toBe(21);
    expect(code(plainRemote.stderr)).toBe("profile_invalid");

    const sshOption = await cli(configDir, [
      "profile",
      "add",
      "ssh-option",
      "--ssh-host",
      "-oProxyCommand=unexpected",
    ]);
    expect(sshOption.code).toBe(21);
    expect(code(sshOption.stderr)).toBe("profile_invalid");
    expect(sshOption.stderr).not.toContain("ProxyCommand");
  });

  test("global --profile only selects an existing Profile and is rejected on local config commands", async () => {
    const configDir = await makeConfigDir();
    const missing = await cli(configDir, ["--profile", "missing", "agents", "list"]);
    expect(missing.code).toBe(20);
    expect(code(missing.stderr)).toBe("profile_not_found");

    const init = await cli(configDir, ["--profile", "remote", "init"]);
    expect(init.code).toBe(2);
    expect(code(init.stderr)).toBe("invalid_usage");

    const show = await cli(configDir, ["--profile", "remote", "profile", "show"]);
    expect(show.code).toBe(2);
    expect(code(show.stderr)).toBe("invalid_usage");
  });

  test("explicit Gateway-only SSH discovery refreshes on 401 and is never selected by daemon Profiles", async () => {
    const configDir = await makeConfigDir();
    await writeProfileFile(configDir, "gateway", {
      version: 1,
      transport: "gateway",
      gateway_url: "https://gateway.example.test",
      ssh_host: "remote",
    });
    let discoveries = 0;
    const auth: string[] = [];
    const result = await captureCli(["--profile", "gateway", "agents", "list"], {
      configDir,
      env: {},
      discoveryPath: "/missing/gateway.json",
      skillsDir,
      runCommand: async (argv) => {
        expect(argv).toEqual([
          "ssh",
          "-o",
          "BatchMode=yes",
          "-o",
          "ConnectTimeout=5",
          "remote",
          "cat /home/box/sand-data/gateway.json",
        ]);
        discoveries += 1;
        return {
          code: 0,
          stdout: JSON.stringify({ token: `session-${discoveries}`, pid: 42, startedAt: discoveries }),
          stderr: "",
        };
      },
      fetch: (async (_input, init) => {
        auth.push(new Headers(init?.headers).get("authorization") ?? "");
        if (auth.length === 1) return Response.json({ error: "expired" }, { status: 401 });
        const { sampleAgents } = await import("./helpers.ts");
        return Response.json(sampleAgents());
      }) as typeof fetch,
    });
    expect(result.code).toBe(0);
    expect(discoveries).toBe(2);
    expect(auth).toEqual(["Bearer session-1", "Bearer session-2"]);
    expect(result.stdout).not.toContain("session-1");
    expect(result.stdout).not.toContain("session-2");
  });

  test("auto and local Profiles prefer local discovery over configured Gateway SSH", async () => {
    const configDir = await makeConfigDir();
    const { startMockGateway, writeDiscovery } = await import("./helpers.ts");
    const gateway = await startMockGateway();
    try {
      const discoveryPath = await writeDiscovery({
        port: gateway.port,
        pid: gateway.pid,
        startedAt: gateway.startedAt,
        token: gateway.token,
      });
      for (const transport of ["auto", "local"] as const) {
        await writeProfileFile(configDir, transport, {
          version: 1,
          transport,
          gateway_url: "https://remote.example.test",
          ssh_host: "remote",
          gateway_discovery: discoveryPath,
        });
        let sshCalls = 0;
        const result = await captureCli(["--profile", transport, "agents", "list"], {
          configDir,
          env: {},
          discoveryPath: "/missing/gateway.json",
          skillsDir,
          runCommand: async () => {
            sshCalls += 1;
            return { code: 1, stdout: "", stderr: "unexpected" };
          },
        });
        expect(result.code).toBe(0);
        expect(sshCalls).toBe(0);
      }
    } finally {
      gateway.stop();
    }
  });

  test("daemon failure never falls back to configured Gateway SSH", async () => {
    const configDir = await makeConfigDir();
    await writeProfileFile(configDir, "daemon-only", {
      version: 1,
      transport: "daemon",
      server_url: "http://127.0.0.1:1",
      daemon_token_ref: "env:DAEMON_TOKEN",
      gateway_url: "https://remote.example.test",
      ssh_host: "remote",
    });
    let sshCalls = 0;
    const result = await captureCli(["--profile", "daemon-only", "agents", "list"], {
      configDir,
      env: { DAEMON_TOKEN: "daemon-secret" },
      discoveryPath: "/missing/gateway.json",
      skillsDir,
      runCommand: async () => {
        sshCalls += 1;
        return { code: 1, stdout: "", stderr: "unexpected" };
      },
    });
    expect(result.code).toBe(26);
    expect(sshCalls).toBe(0);
  });

  test("capabilities distinguish configured Sandbox references from provider authorization", async () => {
    const configDir = await makeConfigDir();
    await writeProfileFile(configDir, "remote", {
      version: 1,
      transport: "daemon",
      server_url: "https://remote.example.ts.net",
      daemon_token_ref: "env:GROKBOX_DAEMON_TOKEN",
      sandbox: { access_token_ref: "keychain:grokbox/cursor" },
      quota: { source: "cursor-web", access_token_ref: "keychain:grokbox/quota" },
    });
    const result = await cli(configDir, ["profile", "capabilities", "remote"]);
    const body = parseJson(result.stdout) as {
      data: { capabilities: Record<string, boolean | string> };
    };
    expect(body.data.capabilities["host.fs.read"]).toBe(true);
    expect(body.data.capabilities["host.fs.write"]).toBe("runtime-policy-dependent");
    expect(body.data.capabilities["host.process.run"]).toBe("runtime-policy-dependent");
    expect(body.data.capabilities["host.process.manage"]).toBe("runtime-policy-dependent");
    expect(body.data.capabilities["host.process.shell"]).toBe("runtime-policy-dependent");
    expect(body.data.capabilities["sandbox.inspect"]).toBe("provider-authorization-dependent");
    expect(body.data.capabilities["sandbox.wake"]).toBe("provider-authorization-dependent");
    expect(body.data.capabilities["sandbox.keepalive"]).toBe("provider-authorization-dependent");
    expect(body.data.capabilities["quota.read"]).toBe("provider-authorization-dependent");
  });

  test("capabilities report auto+server_url as daemon (runtime fallback remains live)", async () => {
    const configDir = await makeConfigDir();
    await writeProfileFile(configDir, "auto-daemon", {
      version: 1,
      transport: "auto",
      server_url: "https://my-daemon.example.test",
      daemon_token_ref: "env:GROKBOX_DAEMON_TOKEN",
    });
    const result = await cli(configDir, ["profile", "capabilities", "auto-daemon"]);
    const body = parseJson(result.stdout) as {
      data: {
        connection: { endpoint: string | null; protocolMajor: number | null };
        capabilities: Record<string, boolean | string>;
      };
    };
    expect(body.data.connection.protocolMajor).toBe(1);
    expect(body.data.connection.endpoint).toBe("https://my-daemon.example.test");
    expect(body.data.capabilities["host.fs.read"]).toBe(true);
    expect(body.data.capabilities["host.fs.write"]).toBe("runtime-policy-dependent");
    expect(body.data.capabilities["host.desktop.read"]).toBe(true);
  });

  test("capabilities report clean gateway (no server_url) as non-daemon", async () => {
    const configDir = await makeConfigDir();
    await writeProfileFile(configDir, "clean-gateway", {
      version: 1,
      transport: "gateway",
      gateway_url: "https://gateway.example.test",
      gateway_token_ref: "env:GROKBOX_GATEWAY_TOKEN",
    });
    const result = await cli(configDir, ["profile", "capabilities", "clean-gateway"]);
    const body = parseJson(result.stdout) as {
      data: {
        connection: {
          endpoint: string | null;
          protocolMajor: number | null;
          credentialReference: string | null;
          credentialConfigured: boolean;
        };
        capabilities: Record<string, boolean | string>;
      };
    };
    expect(body.data.connection.protocolMajor).toBe(null);
    expect(body.data.connection.endpoint).toBe("https://gateway.example.test");
    expect(body.data.connection.credentialReference).toBe("env:GROKBOX_GATEWAY_TOKEN");
    expect(body.data.connection.credentialConfigured).toBe(true);
    expect(body.data.capabilities["host.fs.read"]).toBe(false);
    expect(body.data.capabilities["host.desktop.read"]).toBe(false);
    expect(body.data.capabilities["grok.roster.read"]).toBe(true);
  });

  test("capabilities report clean local (no server_url) as non-daemon", async () => {
    const configDir = await makeConfigDir();
    await writeProfileFile(configDir, "clean-local", {
      version: 1,
      transport: "local",
    });
    const result = await cli(configDir, ["profile", "capabilities", "clean-local"]);
    const body = parseJson(result.stdout) as {
      data: {
        connection: { endpoint: string | null; protocolMajor: number | null };
        capabilities: Record<string, boolean | string>;
      };
    };
    expect(body.data.connection.protocolMajor).toBe(null);
    expect(body.data.capabilities["host.fs.read"]).toBe(false);
    expect(body.data.capabilities["host.fs.write"]).toBe(false);
    expect(body.data.capabilities["host.process.run"]).toBe(false);
    expect(body.data.capabilities["host.desktop.read"]).toBe(false);
    expect(body.data.capabilities["grok.roster.read"]).toBe(true);
  });
});

describe("init discovery boundaries", () => {
  test("local init is idempotent, persists selection, never probes Tailscale, and finishes health", async () => {
    const configDir = await makeConfigDir();
    const { startMockGateway, writeDiscovery } = await import("./helpers.ts");
    const gateway = await startMockGateway();
    try {
      const discoveryPath = await writeDiscovery({
        port: gateway.port,
        pid: gateway.pid,
        startedAt: gateway.startedAt,
        token: gateway.token,
      });
      const overrides = {
        configDir,
        env: {},
        discoveryPath,
        skillsDir,
        runCommand: async () => { throw new Error("Local init must not execute networking tools"); },
      };
      const first = await captureCli(["init", "remote", "--local"], overrides);
      expect(first.code).toBe(0);
      const body = parseJson(first.stdout) as {
        data: { profile: string; target: string; doctor: { ok: boolean } };
      };
      expect(body.data.profile).toBe("remote");
      expect(body.data.target).toBe("local");
      expect(body.data).not.toHaveProperty("tailnet");
      expect(body.data.doctor.ok).toBe(true);
      expect(gateway.requests.map((request) => request.pathname)).toEqual(["/health"]);

      const second = await captureCli(["init", "remote", "--local"], overrides);
      expect(second.code).toBe(0);
      const global = JSON.parse(await readFile(join(configDir, "config.json"), "utf8"));
      expect(global.client.currentProfile).toBe("remote");
    } finally {
      gateway.stop();
    }
  });

  test.each([false, true])("init without local discovery never selects a peer or changes a saved Profile (TTY=%s)", async (stdinIsTTY) => {
    const configDir = await makeConfigDir();
    await writeProfileFile(configDir, "saved", {
      version: 1,
      transport: "daemon",
      server_url: "https://remote.example.ts.net:8443",
      daemon_token_ref: "env:DAEMON_TOKEN",
      ssh_host: "remote",
    });
    const before = await readFile(join(configDir, "config.json"), "utf8");
    const commands: string[][] = [];
    let confirmations = 0;
    const result = await captureCli(["init"], {
      configDir,
      env: {},
      discoveryPath: "/missing/gateway.json",
      skillsDir,
      stdinIsTTY,
      confirm: async () => { confirmations += 1; return true; },
      runCommand: async (argv) => { commands.push([...argv]); return { code: 0, stdout: "{}", stderr: "" }; },
    });
    expect(code(result.stderr)).toBe("discovery_unavailable");
    expect(result.stderr).toContain("profile add");
    expect(commands).toEqual([]);
    expect(confirmations).toBe(0);
    expect(await readFile(join(configDir, "config.json"), "utf8")).toBe(before);
  });

  test.each([
    { argv: ["init", "--peer", "remote"] },
    { argv: ["init", "--bootstrap", "--yes"] },
    { argv: ["init", "--admit-home-read"] },
    { argv: ["daemon", "ensure", "--bootstrap", "--yes"] },
    { argv: ["recover", "--legacy-tailnet"] },
  ])("removed network options are rejected by the current parser before discovery or writes: %j", async ({ argv }) => {
    const configDir = await makeConfigDir();
    const commands: string[][] = [];
    const result = await captureCli([...argv], {
      configDir,
      env: {},
      skillsDir,
      runCommand: async args => { commands.push([...args]); return { code: 0, stdout: "{}", stderr: "" }; },
    });
    expect(result.code).toBe(2);
    expect(code(result.stderr)).toBe("invalid_usage");
    expect(commands).toEqual([]);
    expect(await readFile(join(configDir, "config.json"), "utf8").catch(() => null)).toBeNull();
  });

  test("missing local Gateway fails with local guidance and without mutation", async () => {
    const configDir = await makeConfigDir();
    const result = await cli(configDir, ["init"]);
    expect(result.code).not.toBe(0);
    expect(code(result.stderr)).toBe("discovery_unavailable");
    expect(await readFile(join(configDir, "config.json"), "utf8").catch(() => null)).toBeNull();
  });
});
