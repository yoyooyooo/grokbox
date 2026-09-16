import { nativeHostQualificationEnabled } from "./native-host-qualification.ts";
import { describe, expect, test } from "bun:test";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { shouldTransformArgv } from "../src/internal/host/argv.ts";
import { sha256Bytes, sha256Text } from "@grokbox/runtime-kernel/hash";
import {
  applyPatchProfile,
  extractContractSlices,
  profileFromSource,
  ROUTE_SESSION_SYMBOL,
  sliceHashes,
} from "../src/internal/host/profile.ts";
import { SYNTHETIC_HOST, SYNTHETIC_SLICES } from "./synthetic-host.ts";

const LIVE_HOST = "/home/box/sand-host/host-main.cjs";

async function liveSnapshot(): Promise<{ digest: string | null; pids: string[] }> {
  if (!nativeHostQualificationEnabled()) return { digest: null, pids: [] };
  let digest: string | null = null;
  try {
    digest = sha256Bytes(await readFile(LIVE_HOST));
  } catch {
    digest = null;
  }
  const pids: string[] = [];
  try {
    const proc = Bun.spawn(["ps", "-eo", "pid,args"], { stdout: "pipe", stderr: "pipe" });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    for (const line of text.split("\n")) {
      if (line.includes("host-main.cjs")) pids.push(line.trim().split(/\s+/, 1)[0] ?? "");
    }
  } catch {
    /* ignore */
  }
  return { digest, pids: pids.filter(Boolean) };
}

describe("offline Host transform", () => {
  test("two unique slices transform a copy and the hook returns the original session", () => {
    const profile = profileFromSource(SYNTHETIC_HOST, SYNTHETIC_SLICES);
    const result = applyPatchProfile(SYNTHETIC_HOST, profile);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toContain("agentId: host.getConversationId()");
    expect(result.source).toContain("invocationId: inferenceRequestId");
    expect(result.source).toContain("originalSession: session");

    const module = { exports: {} as { runTurn: (host: { getConversationId: () => string }) => { kind: string; sessionOptions: { agentId: string; invocationId: string } } } };
    const calls: Array<{ originalSession: object; agentId?: string; sessionOptions?: { invocationId?: string } }> = [];
    const sandbox = createContext({
      module,
      exports: module.exports,
      Symbol,
      hook(args: { originalSession: object; agentId?: string }) {
        calls.push(args);
        return args.originalSession;
      },
    });
    runInContext(
      `globalThis[Symbol.for("${ROUTE_SESSION_SYMBOL}")] = hook;\n${result.source}`,
      sandbox,
    );
    const session = module.exports.runTurn({ getConversationId: () => "agent-tom" });
    expect(session.kind).toBe("official-session");
    expect(session.sessionOptions.agentId).toBe("agent-tom");
    expect(session.sessionOptions.invocationId).toBe("inv-synth");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.originalSession).toBe(session);
    expect(calls[0]?.agentId).toBe("agent-tom");
    expect(calls[0]?.sessionOptions?.invocationId).toBe("inv-synth");
  });

  test("unknown digest, missing and duplicate anchors, and transformed mismatch refuse", () => {
    const profile = profileFromSource(SYNTHETIC_HOST, SYNTHETIC_SLICES);
    expect(applyPatchProfile(`${SYNTHETIC_HOST}\n// drift\n`, profile).ok).toBe(false);
    expect(applyPatchProfile(`${SYNTHETIC_HOST}\n// drift\n`, profile)).toMatchObject({ code: "unknown-sha" });

    const missing = { ...profile, slices: profile.slices.map((slice) => ({ ...slice, startAnchor: "nope" })) };
    missing.sourceSha256 = sha256Text(SYNTHETIC_HOST);
    expect(applyPatchProfile(SYNTHETIC_HOST, missing)).toMatchObject({ code: "anchor-missing" });

    const duplicateSource = SYNTHETIC_HOST.replace(
      "function createSession(sessionOptions) {",
      "function createSession(sessionOptions) {\nfunction createSession(sessionOptions) {",
    );
    const dupProfile = { ...profile, sourceSha256: sha256Text(duplicateSource) };
    expect(applyPatchProfile(duplicateSource, dupProfile).ok).toBe(false);

    const badHash = { ...profile, transformedSourceSha256: "0".repeat(64) };
    expect(applyPatchProfile(SYNTHETIC_HOST, badHash)).toMatchObject({ code: "transformed-mismatch" });
  });

  test("non-target argv and --box-copy-in do not transform", () => {
    expect(shouldTransformArgv(["node", "/home/box/sand-host/host-main.cjs"])).toBe(true);
    expect(shouldTransformArgv(["node", "/tmp/host-main.cjs", "--box-copy-in"])).toBe(false);
    expect(shouldTransformArgv(["node", "/usr/bin/grokbox"])).toBe(false);
    expect(shouldTransformArgv(["node", "/home/box/sand-host/other.cjs"])).toBe(false);
  });

  test("owned copy receives slices; optional native observation remains unchanged", async () => {
    const before = await liveSnapshot();
    const dir = join(tmpdir(), `grokbox-host-copy-${process.pid}`);
    await mkdir(dir, { recursive: true });
    const copyPath = join(dir, "host-copy.cjs");
    await writeFile(copyPath, SYNTHETIC_HOST);
    const profile = profileFromSource(SYNTHETIC_HOST, SYNTHETIC_SLICES);
    const result = applyPatchProfile(SYNTHETIC_HOST, profile);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await writeFile(copyPath, result.source);
    expect(await readFile(copyPath, "utf8")).toContain("agentId: host.getConversationId()");
    expect(await readFile(copyPath, "utf8")).toContain("invocationId: inferenceRequestId");
    const extracted = extractContractSlices(result.source);
    expect(extracted["create-session"]).toContain("createSession");
    expect(extracted["session-options"]).toContain("mainSessionOptions");
    expect(extracted["agent-id"]).toContain("agentId: host.getConversationId()");
    expect(extracted["agent-id"]).toContain("invocationId: inferenceRequestId");
    expect(extracted["prompt-session"]).toBeUndefined();
    const hashes = sliceHashes(extracted);
    expect(hashes["create-session"]).toBe(sha256Text(extracted["create-session"] ?? ""));
    const after = await liveSnapshot();
    expect(after).toEqual(before);
    if (before.digest) {
      const liveStat = await stat(LIVE_HOST);
      expect(liveStat.isFile()).toBe(true);
      expect(sha256Bytes(await readFile(LIVE_HOST))).toBe(before.digest);
    }
  });
});
