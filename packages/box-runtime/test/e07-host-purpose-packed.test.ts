import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeReviewedProfileFromCopy } from "../src/internal/process/profile.node.ts";
import { LIVE_SLICE_PATCHES } from "../src/internal/host/live-slices.ts";
import { LIVE_SHAPED_HOST } from "./live-shaped-host.ts";
import { E07_HOST_SUPPORT, E07_STEP, E07_TURN, writeE07Models, auxiliaryEvents } from "./e07-host-fixture.ts";
import { withFakeHttpSession, sseChatOk } from "./context-continuity-fixture.ts";

const PACKED = fileURLToPath(new URL("../../../dist/preload.cjs", import.meta.url));
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

function execute(path: string, dir: string, profile: string, marker: string) {
  return new Promise<{ exit: number | null; out: string; err: string }>((resolve, reject) => {
    const child = spawn("node", ["--require", PACKED, path], {
      stdio: ["ignore", "pipe", "pipe"], timeout: 15_000,
      env: {
        PATH: process.env.PATH, HOME: dir,
        GROKBOX_HOST_BUNDLE: path, GROKBOX_PATCH_PROFILE: profile,
        GROKBOX_OPERATION_ID: "e07-owned-packed", GROKBOX_PRELOAD_MODE: "route",
        GROKBOX_PRELOAD_MARKER: marker, GROKBOX_RUN_ROOT: dir, GROKBOX_BOX_RUNTIME_ROOT: dir,
        GROKBOX_ALLOW_LIVE_HOST: "0", GROKBOX_PACKED_SESSION_FACTORY: "0",
      },
    });
    let out = "", err = "";
    child.stdout.on("data", (bytes) => { out += String(bytes); });
    child.stderr.on("data", (bytes) => { err += String(bytes); });
    child.once("error", reject);
    child.once("close", (exit) => resolve({ exit, out, err }));
  });
}

describe("E07 packed preload / exact compile / real hook (owned Host only)", () => {
  test.each(["positive", "missing-parent", "half-stream", "abort", "old-profile"] as const)("E07 packed %s", async (scenario) => {
    await withFakeHttpSession({ turnId: E07_TURN,
      respond: (n) => scenario === "half-stream" && n === 2
        ? new Response(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "partial-never-committed" }, finish_reason: null }] })}\n\n`, { headers: { "content-type": "text/event-stream" } })
        : sseChatOk(),
      fn: async ({ dir, requests }) => {
        await writeE07Models(dir);
        const source = LIVE_SHAPED_HOST + E07_HOST_SUPPORT + `
(async () => {
  const assert = require("node:assert/strict");
  const scenario = ${JSON.stringify(scenario)};
  const session = await fixtureSession();
  const ctx = fixtureContext();
  const main = session.getExecutor([{ role: "system", content: "owned-main-root" }, { role: "user", content: "owned-main-body" }]);
  if (scenario !== "missing-parent") await main.stream(ctx, ${JSON.stringify(E07_STEP)}).response;
  const before = main.getState();
  const memories = [];
  const abort = new AbortController();
  if (scenario === "abort") abort.abort();
  const memoryCtx = scenario === "abort" ? fixtureContext(undefined, abort.signal) : ctx;
  const memory = () => runTurnMemory({ addMemory(row) { memories.push(row); } }, [1, 2], session, memoryCtx, 1, { user: "purpose: episode (decoy)", agent: "owned-turn" });
  if (["missing-parent", "half-stream", "abort"].includes(scenario)) {
    await assert.rejects(memory);
    assert.deepEqual(memories, []);
  } else {
    await memory();
    assert.deepEqual(memories, [{ purpose: "memory-extraction", text: "ok" }, { purpose: "episode", text: "ok" }]);
  }
  assert.deepEqual(main.getState(), before);
  assert.equal(ctx.grokboxAux, undefined);
  assert.equal(fixtureOfficial.length, 0);
  console.log(JSON.stringify({ scenario, node: process.versions.node, memories: memories.length, official: fixtureOfficial.length }));
})().catch(() => { process.stderr.write("e07-packed-behavior-rejected\\n"); process.exitCode = 1; });
`;
        const path = join(dir, "host-main.cjs");
        const marker = join(dir, "compile-marker.json");
        await writeFile(path, source);
        const slices = scenario === "old-profile" ? LIVE_SLICE_PATCHES.filter((slice) => !slice.id.endsWith("-purpose")) : LIVE_SLICE_PATCHES;
        const profile = await writeReviewedProfileFromCopy({ hostBundle: path, destDir: join(dir, "profiles"), slices, profileId: "e07-packed" });
        expect(profile.profile.slices.map((slice) => slice.id)).toEqual(slices.map((slice) => slice.id));
        const ran = await execute(path, dir, profile.profilePath, marker);
        expect(ran.exit, ran.err).toBe(scenario === "old-profile" ? 1 : 0);
        if (scenario !== "old-profile") expect(JSON.parse(ran.out)).toMatchObject({ scenario, memories: scenario === "positive" ? 2 : 0, official: 0 });
        else expect(ran.err).toContain("e07-packed-behavior-rejected");
        const compiled = JSON.parse(await readFile(marker, "utf8"));
        expect(compiled).toMatchObject({ compiled: true, transformed: true, mode: "route", preloadSha256: sha(await readFile(PACKED)),
          compile: { profileId: "e07-packed", sourceSha256: sha(source), transformedSha256: profile.transformedSourceSha256, profileSha256: sha(await readFile(profile.profilePath)) },
        });
        expect(await readFile(path, "utf8")).toBe(source);
        expect(requests).toHaveLength(scenario === "positive" ? 3 : scenario === "missing-parent" ? 0 : scenario === "half-stream" ? 2 : 1);
        if (scenario === "positive") {
          const events = await auxiliaryEvents(dir, 2);
          expect(events.map((row) => row.auxPurpose).sort()).toEqual(["episode", "memory-extraction"]);
          for (const event of events) {
            expect(event).toMatchObject({ turnId: E07_TURN, parentStepId: E07_STEP, agentId: "agent-tom" });
            expect(event.stepId).not.toBe(E07_STEP);
          }
        }
      },
    });
  }, 30_000);
});
