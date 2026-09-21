import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { parseModelsFile, ROUTE_MODEL_NOT_ADMITTED_MESSAGE } from "@grokbox/runtime-kernel/selection";
import { applyModelChange } from "@grokbox/runtime-kernel/model-management";
import { bindHostSessionHook } from "../packages/box-runtime/src/internal/host/session-hook.ts";
import { isHostManagedFailure } from "../packages/box-runtime/src/internal/host/session.ts";
import { hostEventsPath, settleJournalWrites } from "../packages/box-runtime/src/internal/host/terminal-journal.node.ts";
import { observeRuntimeEvents } from "../packages/box-runtime/src/internal/io/journal.node.ts";
import { projectSendOutcome, SEND_OUTCOME_STATES } from "../packages/cli/src/outcome.ts";
import { writeProfileFile } from "../packages/cli/src/config/profile.ts";
import { ensurePackedCli } from "./packed-cli-fixture.ts";
import { startMockGateway } from "./helpers.ts";

const agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", otherId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const modelId = "synthetic-denied/model";
const document = () => ({ version: 3, models: { [modelId]: {
  provider: "unsupported-fixture", model: "none", endpoint: "https://no-network.invalid/v1", apiKeyRef: "env:PRIVATE_INPUT_MUST_NOT_LEAK",
  capabilities: { tools: true, images: false, vision: false }, dataTypes: ["text", "tools"],
} }, assignments: { main: null, agents: { [agentId]: { modelId } } } });

test("current model management refuses an unsupported provider without requiring a live fault-injection writer", () => {
  const source = parseModelsFile({ ...document(), assignments: { main: null, agents: {} } }), before = JSON.stringify(source);
  expect(() => applyModelChange(source, { kind: "bot-selection", agentId, selection: { kind: "model", modelId } })).toThrow();
  expect(JSON.stringify(source)).toBe(before);
  expect(SEND_OUTCOME_STATES).not.toContain("accepted");
});

for (const shape of ["unsupported-model", "retired-document"] as const) {
  for (const echo of [false, true]) test(`real hook rejection -> journal -> fresh packed Node outcome, ${shape}, echo=${echo}`, async () => {
    const cli = ensurePackedCli(), root = await mkdtemp(join(tmpdir(), "grokbox-admission-proof-"));
    const durableRoot = join(root, "durable"), runRoot = join(root, "run"), configDir = join(root, "config");
    const nonce = randomUUID(), turnId = randomUUID(), reason = shape === "unsupported-model" ? "route-model-not-admitted" : "selection-unavailable";
    const entries = echo ? [{ kind: "message", id: "t0u", role: "user", clientNonce: nonce, requestId: null }] : [];
    const gateway = await startMockGateway({ agents: [{ id: agentId, name: "fixture", isGroup: false, harness: "box" }],
      tail: { entries, truncated: !echo }, trays: [] });
    let officialCalls = 0;
    try {
      await mkdir(durableRoot, { mode: 0o700 });
      const bytes = JSON.stringify({ ...document(), version: shape === "retired-document" ? 2 : 3 });
      const modelPath = join(durableRoot, "models.json"); await writeFile(modelPath, bytes, { mode: 0o600 });
      const hook = bindHostSessionHook({ mode: "route", durableRoot, runRoot });
      const requestIds: string[] = [];
      let rejection: unknown;
      try {
        hook({ agentId, originalSession: { getExecutor() { officialCalls++; throw Error("native-fallback-forbidden"); } },
          onRequestId: id => { requestIds.push(id); }, sessionOptions: { invocationId: turnId, clientNonce: nonce } });
      } catch (error) { rejection = error; }
      expect(isHostManagedFailure(rejection)).toBe(true);
      if (shape === "unsupported-model") expect(rejection).toMatchObject({ failureCode: "route_model_not_admitted", message: ROUTE_MODEL_NOT_ADMITTED_MESSAGE });
      else expect(rejection).toMatchObject({ code: "runtime_config_invalid" });
      expect(requestIds).toEqual([]); expect(officialCalls).toBe(0);
      await settleJournalWrites(runRoot);
      const observed = await observeRuntimeEvents({ durableRoot, runRoot, source: "host" });
      const rejected = observed.events.filter(row => "name" in row && row.name === "host_stream_rejected");
      expect(rejected).toHaveLength(1);
      expect(rejected[0]).toMatchObject({ agentId, turnId, clientNonce: nonce, reason, stage: "admit" });
      expect(JSON.stringify(observed.events)).not.toContain("PRIVATE_INPUT_MUST_NOT_LEAK");
      const base = { agentId, nonce, entries, alerts: [], truncated: !echo, runtimeEvents: observed.events };
      expect(projectSendOutcome(base)).toMatchObject({ state: "failed", requestId: null, echoObserved: echo, runtimeFailure: { reason } });
      expect(projectSendOutcome({ ...base, nonce: randomUUID() }).state).not.toBe("failed");
      expect(projectSendOutcome({ ...base, agentId: otherId }).state).not.toBe("failed");

      const discovery = join(root, "gateway.json");
      await writeFile(discovery, JSON.stringify({ scheme: "http", host: "127.0.0.1", port: gateway.port,
        pid: gateway.pid, startedAt: gateway.startedAt, token: gateway.token }), { mode: 0o600 });
      await writeProfileFile(configDir, "default", { version: 1, transport: "local", gateway_discovery: discovery });
      const journalBefore = await readFile(hostEventsPath(runRoot));
      const query = async (selectedNonce: string) => {
        const child = Bun.spawn(["node", cli, "history", "outcome", agentId, "--nonce", selectedNonce, "--runtime", "--json"], {
          stdin: "ignore", stdout: "pipe", stderr: "pipe",
          env: { PATH: process.env.PATH ?? "", HOME: root, GROKBOX_CONFIG_DIR: configDir,
            GROKBOX_BOX_RUNTIME_ROOT: durableRoot, GROKBOX_RUN_ROOT: runRoot },
        });
        const deadline = setTimeout(() => child.kill("SIGKILL"), 10000);
        try {
          const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
          expect(status, stderr || stdout).toBe(0); expect(stderr).toBe("");
          expect(stdout).not.toContain("PRIVATE_INPUT_MUST_NOT_LEAK"); expect(stdout).not.toContain(gateway.token);
          return JSON.parse(stdout);
        } finally {
          clearTimeout(deadline); if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
        }
      };
      for (let read = 0; read < 2; read++) expect(await query(nonce)).toMatchObject({ ok: true, data: {
        state: "failed", requestId: null, echoObserved: echo, alerts: [], runtimeFailure: { reason }, executionCompleted: "not_proven",
      } });
      expect((await query(randomUUID())).data.state).not.toBe("failed");
      expect(gateway.requests.length).toBeGreaterThan(0);
      expect(gateway.requests.filter(row => /sendPrompt|createAgent|updateAgent|deleteAgent/.test(row.pathname))).toEqual([]);
      expect(await readFile(modelPath, "utf8")).toBe(bytes);
      expect(await readFile(hostEventsPath(runRoot))).toEqual(journalBefore);
      expect(officialCalls).toBe(0);
    } finally {
      await settleJournalWrites(runRoot); gateway.stop(); await rm(root, { recursive: true, force: true });
    }
  }, 45000);
}

test("current observation guidance preserves original identities and never prescribes fault injection into a live model document", async () => {
  const guide = await readFile(new URL("../docs/maintainers/run-outcome-observation.md", import.meta.url), "utf8");
  expect(guide).toContain("history outcome <agent-id> --nonce <clientNonce> --runtime");
  expect(guide).toContain("runtime incident <step-id> --agent <agent-id>");
  expect(guide).toContain("查询缺少关联时保持未知");
  expect(guide).not.toContain("verify-ah92-admit-observation");
});
