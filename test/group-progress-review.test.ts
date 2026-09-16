import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureCli, parseJson } from "./helpers.ts";

const groupId = "11111111-2222-4333-8444-555555555555";
function event(state: string, generation = "generation-one", agentId = "member-a") {
  return { name: "host_run_observation", at: "2026-09-16T00:00:00.000Z", hostGenerationId: generation,
    agentId, dispatchId: "reused-in-fixture", groupDispatchId: "group-dispatch", groupId, state, source: "group-member" };
}

test("group query filters before busy unrelated Bots consume the global tail budget", async () => {
  const dir = await mkdtemp(join(tmpdir(), "group-progress-review-"));
  const runRoot = join(dir, "run"), path = join(runRoot, "log", "events.ndjson");
  try {
    await mkdir(join(runRoot, "log"), { recursive: true });
    const rows = [event("queued"), event("started"), event("reply_buffered"), event("finished"),
      ...Array.from({ length: 700 }, (_, i) => ({ ...event("finished", "other-generation", `other-${i}`), groupId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", dispatchId: `other-${i}` }))];
    await writeFile(path, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    const before = await readFile(path, "utf8");
    const result = await captureCli(["runtime", "group-progress", groupId], {
      configDir: dir, env: { GROKBOX_RUN_ROOT: runRoot }, boxRuntimeRoot: join(dir, "durable"),
      discoveryPath: join(dir, "no-gateway"), daemonSocket: join(dir, "no-daemon"), transport: "local", stdinIsTTY: true,
    });
    expect(result.code, result.stderr).toBe(0);
    expect(parseJson(result.stdout)).toMatchObject({ data: {
      groupId, members: [{ agentId: "member-a", hostGenerationId: "generation-one", lastState: "finished", replyState: "buffered_not_published", publication: "not_observed" }],
      evidence: { instrumentation: "observed", window: { matchedEvents: 4, returnedEvents: 4 } },
    } });
    expect(await readFile(path, "utf8")).toBe(before);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("group dispatch aggregation keeps Host generations and member identities separate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "group-generations-review-"));
  const runRoot = join(dir, "run");
  try {
    await mkdir(join(runRoot, "log"), { recursive: true });
    await writeFile(join(runRoot, "log", "events.ndjson"), [event("failed"), event("started", "generation-two"), event("queued", "generation-two", "member-b")].map(row => JSON.stringify(row)).join("\n") + "\n");
    const result = await captureCli(["runtime", "group-progress", groupId], {
      configDir: dir, env: { GROKBOX_RUN_ROOT: runRoot }, boxRuntimeRoot: join(dir, "durable"),
      discoveryPath: join(dir, "no-gateway"), daemonSocket: join(dir, "no-daemon"), transport: "local", stdinIsTTY: true,
    });
    expect(result.code, result.stderr).toBe(0);
    const data = parseJson(result.stdout) as { data: { members: unknown[] } };
    expect(data.data.members).toHaveLength(3);
    expect(data.data.members).toMatchObject([
      { hostGenerationId: "generation-one", agentId: "member-a", lastState: "failed" },
      { hostGenerationId: "generation-two", agentId: "member-a", lastState: "started" },
      { hostGenerationId: "generation-two", agentId: "member-b", lastState: "queued" },
    ]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
