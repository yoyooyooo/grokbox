import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { catalogAgentMessage } from "@grokbox/box-runtime/runtime";
import { SEND_OUTCOME_STATES } from "../packages/cli/src/outcome.ts";
import { BoxRuntimeError } from "@grokbox/runtime-kernel/contract";
import {
  ROUTE_MODEL_NOT_ADMITTED_MESSAGE,
  decideRouteSession,
  parseModelsFile,
  requireModel,
} from "@grokbox/runtime-kernel/selection";

const root = fileURLToPath(new URL("../", import.meta.url));
const script = join(root, "scripts/verify-ah92-admit-observation.mjs");

test("AH-92.5 maintainer script is confirm-gated and stays on the canary path", () => {
  const source = readFileSync(script, "utf8");
  expect(source).toContain("grokbox send");
  expect(source).toContain("history");
  expect(source).toContain("outcome");
  expect(source).toContain("--nonce");
  expect(source).toContain("--runtime");
  expect(source).toContain("--confirm");
  expect(source).toContain("models.json");
  expect(source).not.toContain("alerts list --nonce");
  expect(source).not.toContain("correlationId");
  expect(source).toContain("protected_canary_refused");

  const help = spawnSync(process.execPath, [script, "--help"], { cwd: root, encoding: "utf8", timeout: 10_000 });
  expect(help.status).toBe(0);
  const helpJson = JSON.parse(help.stdout);
  expect(helpJson.canary[0]).toContain("grokbox send");
  expect(helpJson.canary[1]).toContain("history outcome");
  expect(helpJson.canary[1]).toContain("--nonce");
  expect(helpJson.canary[1]).toContain("--runtime");

  const refused = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8", timeout: 10_000 });
  expect(refused.status).toBe(2);
  expect(JSON.parse(refused.stdout)).toMatchObject({ ok: false, error: "confirm_required", mutation: false });
});

test("AH-92.5 unofficial assignment is the admit-deny negative because models use cannot save it", () => {
  const file = parseModelsFile({
    version: 3,
    models: {
      "ah92-admit-deny/none": {
        provider: "acme",
        model: "none",
        endpoint: "https://example.test/v1",
        apiKeyRef: "env:AH92_ADMIT_DENY_KEY",
        capabilities: { vision: false, tools: true, images: false },
        dataTypes: ["text", "tools"],
      },
    },
    assignments: { main: { modelId: "stub/echo" }, agents: { "00000000-0000-4000-8000-000000000119": { modelId: "ah92-admit-deny/none" } } },
  });
  expect(() => requireModel(file, "acme/fast")).toThrow(BoxRuntimeError);
  try {
    requireModel(file, "acme/fast");
  } catch (error) {
    expect(error).toMatchObject({ message: "Unknown model 'acme/fast'. Add it to models.json first." });
  }
  expect(() => decideRouteSession(file, "00000000-0000-4000-8000-000000000119")).toThrow(BoxRuntimeError);
  try {
    decideRouteSession(file, "00000000-0000-4000-8000-000000000119");
  } catch (error) {
    expect(error).toMatchObject({
      failureCode: "route_model_not_admitted",
      message: ROUTE_MODEL_NOT_ADMITTED_MESSAGE,
    });
  }
  expect(catalogAgentMessage("route-model-not-admitted")).toBe("route admits only stub/echo or openai* in this slice.");
  expect(SEND_OUTCOME_STATES).not.toContain("accepted");
});

test("observation guidance binds existing operations and keeps missing evidence distinct from success", () => {
  const observation = readFileSync(join(root, "docs/maintainers/run-outcome-observation.md"), "utf8");
  expect(observation).toContain("history outcome <agent-id> --nonce <clientNonce> --runtime");
  // The actual admission negative remains exercised above. A current runbook
  // need not carry an obsolete experiment's model list or synthetic target.
  expect(observation).toContain("runtime incident <step-id> --agent <agent-id>");
  expect(observation).toContain("history outcome <agent-id> --step-id <step-id> --runtime");
  expect(observation).not.toContain("alerts list --nonce");
  expect(observation).toContain("查询缺少关联时保持未知");
  expect(observation).toContain("不是没有失败");
  expect(observation).not.toMatch(/data\.state\s*=\s*accepted/);
});


test("maintainer observation has no implicit live target and refuses before reading runtime files", () => {
  const protectedId = "00000000-0000-4000-8000-000000000001";
  const cases: Array<[string[], string]> = [
    [["--confirm"], "agent_required"],
    [["--confirm", "--agent", "fixture-agent"], "protected_agent_id_required"],
    [["--confirm", "--agent", "fixture-agent", "--protected-agent-id", "invalid"], "protected_agent_id_required"],
    [["--confirm", "--agent", protectedId, "--protected-agent-id", protectedId], "protected_canary_refused"],
    [["--confirm", "--agent", "GROKBOX", "--protected-agent-id", protectedId], "protected_canary_refused"],
    [["--confirm", "--agent", "fixture-agent", "--protected-agent-id", protectedId, "--nonce", "bad"], "invalid_nonce"],
    [["--confirm", "--agent"], "invalid_arguments"],
  ];
  for (const [args, error] of cases) {
    const ran = spawnSync(process.execPath, [script, ...args], {
      cwd: root, encoding: "utf8", timeout: 10_000,
      env: { PATH: process.env.PATH, GROKBOX_BOX_RUNTIME_ROOT: "/nonexistent-publication-test-root" },
    });
    expect(ran.status).toBe(2);
    expect(JSON.parse(ran.stdout)).toMatchObject({ ok: false, error, mutation: false });
    expect(ran.stderr).toBe("");
  }
});
