import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { runDaemonEnsure } from "../packages/cli/src/commands/daemon.ts";
import type { DaemonProcessConfig } from "../packages/cli/src/daemon/config.ts";
import { ProcessAuthority } from "@grokbox/box-runtime/runtime";
import { createProductionDeps, type FetchFn } from "../packages/cli/src/deps.ts";
import { httpStatusToError } from "../packages/cli/src/errors.ts";
import { GatewayClient } from "../packages/cli/src/gateway.ts";

const describeLinux = process.platform === "linux" ? describe : describe.skip;

function handshake() {
  return {
    protocolMajor: 1,
    daemonVersion: "0.0.1",
    daemonPid: 1,
    startedAt: 1,
    daemonGeneration: "11111111-1111-4111-8111-111111111111",
    capabilities: [],
    gateway: { pid: 2, startedAt: 2 },
  };
}

describe("Detail absorb regressions", () => {
  test("unmapped 4xx Gateway statuses are client errors, not internal", () => {
    const client = httpStatusToError(422, "unprocessable", "Gateway request failed.");
    expect(client.code).toBe("gateway_bad_request");
    expect(client.exitCode).toBe(10);
    const redirect = httpStatusToError(302, undefined, "Gateway request failed.");
    expect(redirect.code).toBe("gateway_bad_request");
    const server = httpStatusToError(503, undefined, "Gateway request failed.");
    expect(server.code).toBe("gateway_internal");
    expect(server.exitCode).toBe(15);
  });

  test("confirm maps abort to false instead of leaking AbortError", async () => {
    const controller = new AbortController();
    controller.abort();
    const deps = createProductionDeps(controller.signal);
    await expect(deps.confirm("delete? [y/N] ")).resolves.toBe(false);
  });

  test("direct-gateway fetch aborts when deps.signal fires", async () => {
    const userAbort = new AbortController();
    let fetchSignal: AbortSignal | undefined;
    const deps = {
      ...createProductionDeps(userAbort.signal),
      transport: "local" as const,
      discoveryPath: "/tmp/grokbox-gateway-abort.json",
      readFile: async () => JSON.stringify({
        scheme: "http", host: "127.0.0.1", port: 31337, pid: 1, startedAt: 1, token: "test-token",
      }),
      fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
        fetchSignal = init?.signal ?? undefined;
        return await new Promise<Response>((resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
            return;
          }
          signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          }, { once: true });
        });
      }) as FetchFn,
    };
    const pending = new GatewayClient(deps).health(10_000);
    for (let i = 0; i < 50 && fetchSignal === undefined; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(fetchSignal).toBeDefined();
    const started = Date.now();
    userAbort.abort();
    const error = await pending.catch((failure) => failure);
    expect(Date.now() - started).toBeLessThan(400);
    expect(fetchSignal?.aborted).toBe(true);
    expect(error).toMatchObject({ code: "gateway_unreachable" });
  });

  test("cancelled daemon ensure does not spawn SSH recovery", async () => {
    const controller = new AbortController();
    controller.abort();
    const commands: string[][] = [];
    const deps = {
      ...createProductionDeps(controller.signal),
      daemonServerUrl: "https://box.example.ts.net:8443",
      sshHost: "box.example.ts.net",
      daemonToken: "test-token",
      fetch: (async (..._args: Parameters<FetchFn>): Promise<Response> => {
        throw new Error("unreachable");
      }) as FetchFn,
      runCommand: async (argv: readonly string[]) => {
        commands.push([...argv]);
        return { code: 130, stdout: "", stderr: "Command cancelled." };
      },
      stdout: { write() {} },
      stderr: { write() {} },
    };
    await expect(runDaemonEnsure(deps, {})).rejects.toMatchObject({ code: "daemon_unreachable" });
    expect(commands).toEqual([]);
  });

});

describeLinux("Detail absorb linux process paths", () => {
  test("ProcessAuthority admits a real executable behind a symlinked ancestor directory", async () => {
    const node = Bun.which("node");
    if (!node) throw new Error("Node.js is unavailable in PATH.");
    const real = await realpath(node);
    const root = await mkdtemp(join(tmpdir(), "grokbox-process-usrmerge-"));
    const linkedBin = join(root, "bin");
    await symlink(dirname(real), linkedBin);
    const viaAncestor = join(linkedBin, basename(real));
    const policy: DaemonProcessConfig = {
      cwdRoots: ["workspace"],
      defaultCwdRoot: "workspace",
      executables: [{ name: "node", path: viaAncestor }],
      environment: [],
      maxConcurrent: 1,
      maxQueued: 1,
      maxRuntimeMs: 1000,
      maxOutputBytes: 1024,
    };
    const authority = await ProcessAuthority.create(policy);
    expect((await authority.executable("node", false)).path).toBe(viaAncestor);

    const linkFile = join(root, "node-link");
    await symlink(real, linkFile);
    await expect(ProcessAuthority.create({
      ...policy,
      executables: [{ name: "node", path: linkFile }],
    })).rejects.toMatchObject({ code: "process_forbidden" });
  });
});
