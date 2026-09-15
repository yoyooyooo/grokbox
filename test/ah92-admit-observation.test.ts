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
    version: 1,
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
    assignments: { main: "stub/echo", agents: { "00000000-0000-4000-8000-000000000119": "ah92-admit-deny/none" } },
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

test("AH-92.5 observation docs keep the two-command canary and unofficial-assignment negative", () => {
  const observation = readFileSync(join(root, "docs/maintainers/run-outcome-observation.md"), "utf8");
  expect(observation).toContain("history outcome <agent-id> --nonce <clientNonce> --runtime");
  expect(observation).toContain("route admits only stub/echo or openai* in this slice.");
  expect(observation).toContain("ah92-admit-deny/none");
  expect(observation).toContain("verify-ah92-admit-observation.mjs");
  expect(observation).toContain("不要用 `alerts list --nonce`");
  expect(observation).not.toMatch(/data\.state\s*=\s*accepted/);
});
