import { test, vi } from "bun:test";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import * as nodeFsNS from "node:fs";

const fault: {
  rmEioNext: number;
  rmEioAll: boolean;
  rmEaccesAll: boolean;
  linkEacces: boolean;
} = { rmEioNext: 0, rmEioAll: false, rmEaccesAll: false, linkEacces: false };
let rmTempCalls = 0;
const methods: string[] = [];

vi.mock("node:fs/promises", async () => {
  const real = nodeFsNS.promises as typeof import("node:fs/promises");
  const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });
  const isTemp = (path: unknown): boolean => typeof path === "string" && path.includes(".grokbox-");
  return {
    ...real,
    rm: (async (...args: Parameters<typeof real.rm>) => {
      if (isTemp(args[0])) {
        rmTempCalls += 1;
        if (fault.rmEaccesAll) throw errno("EACCES");
        if (fault.rmEioAll) throw errno("EIO");
        if (fault.rmEioNext > 0) {
          fault.rmEioNext -= 1;
          throw errno("EIO");
        }
      }
      return real.rm(...args);
    }) as typeof real.rm,
    link: (async (...args: Parameters<typeof real.link>) => {
      if (fault.linkEacces && isTemp(args[0])) throw errno("EACCES");
      return real.link(...args);
    }) as typeof real.link,
  };
});

const fakeHandshake = {
  protocolMajor: 1,
  daemonVersion: "0.0.1",
  daemonPid: 1,
  startedAt: 1,
  daemonGeneration: "11111111-1111-4111-8111-111111111111",
  gateway: { pid: 1, startedAt: 1 },
};

type Scenario = {
  bytes?: string;
  rmEioNext?: number;
  rmEioAll?: boolean;
  rmEaccesAll?: boolean;
  linkEacces?: boolean;
  remoteName?: string;
};

test("fs download leak fault scenario", async () => {
  const scenario = JSON.parse(process.env.FS_FAULT ?? "{}") as Scenario;
  fault.rmEioNext = scenario.rmEioNext ?? 0;
  fault.rmEioAll = Boolean(scenario.rmEioAll);
  fault.rmEaccesAll = Boolean(scenario.rmEaccesAll);
  fault.linkEacces = Boolean(scenario.linkEacces);

  const bytes = Buffer.from(scenario.bytes ?? "hello");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const remoteName = scenario.remoteName ?? "file.bin";
  const remote = `home:/${remoteName}`;

  const { captureCli } = await import("./helpers.ts");
  const { writeProfileFile } = await import("../src/config/profile.ts");
  const { FS_TRANSFER_CHUNK_BYTES } = await import("../src/daemon/filesystem.ts");
  const { mkdtemp, readdir, readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");

  const configDir = await mkdtemp(join(tmpdir(), "grokbox-leak-cfg-"));
  const destinationDir = await mkdtemp(join(tmpdir(), "grokbox-leak-out-"));
  const destination = join(destinationDir, "out.bin");
  await writeProfileFile(configDir, "remote", {
    version: 1,
    transport: "daemon",
    server_url: "http://127.0.0.1:12345",
    daemon_token_ref: "env:DAEMON_TOKEN",
  });

  const fetchFn = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { method: string; params: Record<string, unknown> };
    methods.push(request.method);
    const transferId = String(request.params.transferId);
    if (request.method === "handshake") {
      return Response.json({ ok: true, result: {
        ...fakeHandshake,
        capabilities: ["host.fs.read"],
        filesystemRoots: [{ name: "home", operations: ["download"] }],
      } });
    }
    if (request.method === "fsDownloadOpen") {
      return Response.json({ ok: true, result: {
        transferId,
        path: remote,
        root: "home",
        size: bytes.length,
        sha256,
        chunkBytes: FS_TRANSFER_CHUNK_BYTES,
        chunks: Math.ceil(bytes.length / FS_TRANSFER_CHUNK_BYTES) || 0,
      } });
    }
    if (request.method === "fsDownloadChunk") {
      return Response.json({ ok: true, result: {
        transferId,
        index: 0,
        bytes: bytes.length,
        contentBase64: bytes.toString("base64"),
        done: true,
      } });
    }
    return Response.json({ ok: true, result: { transferId, cancelled: true } });
  }) as typeof fetch;

  const result = await captureCli(["--profile", "remote", "fs", "download", remote, destination], {
    configDir,
    skillsDir: join(import.meta.dir, "..", "skills"),
    env: { DAEMON_TOKEN: "secret" },
    fetch: fetchFn,
  });

  const listing = await readdir(destinationDir);
  const temps = listing.filter((name) => name.includes(".grokbox-"));
  let verified: boolean | null = null;
  let destContent: string | null = null;
  try {
    const body = JSON.parse(result.stdout) as { data?: { verified?: boolean } };
    if (typeof body.data?.verified === "boolean") verified = body.data.verified;
  } catch {
    verified = null;
  }
  try {
    destContent = await readFile(destination, "utf8");
  } catch {
    destContent = null;
  }

  const outcome = {
    code: result.code,
    verified,
    rmTempCalls,
    temps,
    listing,
    lastMethod: methods.at(-1) ?? null,
    destContent,
  };
  const resultFile = process.env.FS_RESULT_FILE;
  if (resultFile) writeFileSync(resultFile, JSON.stringify(outcome));
});
