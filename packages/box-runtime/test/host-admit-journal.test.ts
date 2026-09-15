import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoxRuntimeError } from "@grokbox/runtime-kernel/contract";
import {
  ROUTE_MODEL_NOT_ADMITTED_FAILURE_CODE,
  ROUTE_MODEL_NOT_ADMITTED_MESSAGE,
} from "@grokbox/runtime-kernel/selection";
import { bindHostSessionHook } from "../src/internal/host/session-hook.ts";
import { isHostManagedFailure } from "../src/internal/host/session.ts";
import {
  appendHostStreamRejected,
  hostEventsPath,
  projectHostSeamStage,
  projectHostStreamRejected,
} from "../src/internal/host/terminal-journal.node.ts";
import { observeRuntimeEvents } from "../src/internal/io/journal.node.ts";
import { mapAdmitCatch } from "../src/internal/host/failure-catalog.ts";

const AT = "2026-01-01T00:00:00.000Z";
const NONCE = "00000000-0000-4000-8000-000000000119";
const official = { kind: "official" };

async function waitRows(root: string, match: (row: Record<string, unknown>) => boolean): Promise<Array<Record<string, unknown>>> {
  const started = Date.now();
  let rows: Array<Record<string, unknown>> = [];
  while (Date.now() - started < 2000) {
    try {
      rows = (await readFile(hostEventsPath(root), "utf8"))
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    } catch {
      rows = [];
    }
    if (rows.some(match)) return rows;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return rows;
}

function refusedModels() {
  return {
    version: 1,
    models: {
      "acme/fast": {
        provider: "acme",
        model: "fast",
        endpoint: "https://example.test/v1",
        apiKeyRef: "env:KEY",
        capabilities: { vision: false, tools: true, images: false },
        dataTypes: ["text", "tools"],
      },
    },
    assignments: { main: null, agents: { "agent-tom": "acme/fast" } },
  };
}

describe("AH-92 admit journal catch-all", () => {
  test("route-model-not-admitted writes and observes clientNonce without free-form message", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokbox-admit-journal-"));
    await writeFile(join(root, "models.json"), `${JSON.stringify(refusedModels())}\n`);
    const mapped = mapAdmitCatch(new BoxRuntimeError("invalid_usage", ROUTE_MODEL_NOT_ADMITTED_MESSAGE, {
      failureCode: ROUTE_MODEL_NOT_ADMITTED_FAILURE_CODE,
    }));
    const payload = {
      name: "host_stream_rejected" as const,
      schemaVersion: 2 as const,
      at: AT,
      mode: "route" as const,
      agentId: "agent-tom",
      turnId: "turn-1",
      clientNonce: NONCE,
      stage: mapped.stage,
      errorCode: mapped.errorCode,
      reason: mapped.reason,
      message: ROUTE_MODEL_NOT_ADMITTED_MESSAGE,
      code: "invalid_usage",
    };
    expect(await appendHostStreamRejected(root, payload)).toBe("written");
    const observed = await observeRuntimeEvents({ durableRoot: root, runRoot: root, source: "host" });
    expect(observed.events).toEqual([{
      name: "host_stream_rejected",
      schemaVersion: 2,
      at: AT,
      mode: "route",
      agentId: "agent-tom",
      turnId: "turn-1",
      clientNonce: NONCE,
      stage: "admit",
      errorCode: "runtime_config_invalid",
      reason: "route-model-not-admitted",
    }]);
    const text = JSON.stringify(observed);
    expect(text).not.toContain("invalid_usage");
    expect(text).not.toContain(ROUTE_MODEL_NOT_ADMITTED_MESSAGE);
    expect(observed.events[0]).not.toHaveProperty("message");
    expect(projectHostStreamRejected({ ...payload, schemaVersion: 3 })).toBeNull();
  });

  test("hook catch-all marks, journals, rethrows, and never calls onRequestId", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokbox-admit-hook-"));
    await writeFile(join(root, "models.json"), `${JSON.stringify(refusedModels())}\n`);
    const hook = bindHostSessionHook({ mode: "route", durableRoot: root, runRoot: root });
    const requestIds: string[] = [];
    let caught: unknown;
    try {
      hook({
        originalSession: official,
        agentId: "agent-tom",
        onRequestId: (id) => requestIds.push(id),
        sessionOptions: { invocationId: "turn-owned", agentId: "agent-tom", clientNonce: NONCE },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BoxRuntimeError);
    expect(caught).toMatchObject({
      code: "invalid_usage",
      failureCode: ROUTE_MODEL_NOT_ADMITTED_FAILURE_CODE,
      message: ROUTE_MODEL_NOT_ADMITTED_MESSAGE,
    });
    expect(isHostManagedFailure(caught)).toBe(true);
    expect(requestIds).toEqual([]);
    const rows = await waitRows(root, (row) => row.reason === "route-model-not-admitted");
    expect(rows.some((row) => row.stage === "hook_enter" && row.clientNonce === NONCE)).toBe(true);
    const reject = rows.find((row) => row.reason === "route-model-not-admitted");
    expect(reject).toMatchObject({
      name: "host_stream_rejected",
      schemaVersion: 2,
      stage: "admit",
      errorCode: "runtime_config_invalid",
      reason: "route-model-not-admitted",
      agentId: "agent-tom",
      turnId: "turn-owned",
      clientNonce: NONCE,
    });
    expect(reject).not.toHaveProperty("message");
    expect(JSON.stringify(reject)).not.toContain("invalid_usage");
    expect(projectHostSeamStage(rows.find((row) => row.stage === "hook_enter"))).toMatchObject({
      name: "host_seam_stage",
      schemaVersion: 1,
      clientNonce: NONCE,
      turnId: "turn-owned",
    });
  });

  test("selection-unavailable catch-all still marks, journals nonce, and rethrows", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokbox-admit-unavailable-"));
    const hook = bindHostSessionHook({ mode: "route", durableRoot: root, runRoot: root });
    let caught: unknown;
    try {
      hook({
        originalSession: official,
        agentId: "agent-tom",
        sessionOptions: { invocationId: "turn-owned", clientNonce: NONCE },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "runtime_config_invalid" });
    expect(isHostManagedFailure(caught)).toBe(true);
    const rows = await waitRows(root, (row) => row.reason === "selection-unavailable");
    expect(rows.find((row) => row.reason === "selection-unavailable")).toMatchObject({
      name: "host_stream_rejected",
      schemaVersion: 2,
      stage: "admit",
      errorCode: "runtime_config_invalid",
      clientNonce: NONCE,
      turnId: "turn-owned",
    });
  });

  test("admit-threw projector round-trip drops invalid nonce and free-form message", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokbox-admit-threw-"));
    const mapped = mapAdmitCatch(new TypeError("unexpected token prompt"));
    expect(mapped.reason).toBe("admit-threw");
    expect(await appendHostStreamRejected(root, {
      name: "host_stream_rejected",
      schemaVersion: 2,
      at: AT,
      mode: "route",
      agentId: "agent-tom",
      turnId: "turn-1",
      clientNonce: "not-a-uuid",
      message: "unexpected token prompt",
      ...mapped,
    })).toBe("written");
    const observed = await observeRuntimeEvents({ durableRoot: root, runRoot: root, source: "host" });
    expect(observed.events).toEqual([{
      name: "host_stream_rejected",
      schemaVersion: 2,
      at: AT,
      mode: "route",
      agentId: "agent-tom",
      turnId: "turn-1",
      stage: "admit",
      errorCode: "invalid_envelope",
      reason: "admit-threw",
    }]);
    expect(JSON.stringify(observed)).not.toContain("token");
    expect(JSON.stringify(observed)).not.toContain("prompt");
  });
});
