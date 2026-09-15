import { describe, expect, test } from "bun:test";
import { BoxRuntimeError } from "@grokbox/runtime-kernel/contract";
import {
  ROUTE_MODEL_NOT_ADMITTED_FAILURE_CODE,
  ROUTE_MODEL_NOT_ADMITTED_MESSAGE,
} from "@grokbox/runtime-kernel/selection";
import {
  HOST_FAILURE_CATALOG,
  HOST_JOURNAL_FORBIDDEN,
  INVALID_STREAM_AGENT_MESSAGE,
  catalogAgentMessage,
  catalogByFailureCode,
  catalogByReason,
  mapAdmitCatch,
  mapTerminalReject,
} from "../src/internal/host/failure-catalog.ts";
import { HostSelectionUnavailableError } from "../src/internal/host/selection.node.ts";
import {
  HOST_STREAM_REJECT_REASONS,
  TURN_SEAM_ERROR_CODES,
} from "../src/internal/host/terminal-journal.node.ts";
import {
  HOST_STREAM_REJECT_REASONS as journalReasons,
  TURN_SEAM_ERROR_CODES as journalCodes,
} from "../src/internal/io/journal.node.ts";

describe("Host failure catalog", () => {
  test("every catalog row has a unique reason on the projector allowlist", () => {
    const reasons = HOST_FAILURE_CATALOG.map((row) => row.reason);
    expect(new Set(reasons).size).toBe(reasons.length);
    for (const row of HOST_FAILURE_CATALOG) {
      expect(HOST_STREAM_REJECT_REASONS.has(row.reason)).toBe(true);
      expect(TURN_SEAM_ERROR_CODES.has(row.errorCode)).toBe(true);
      expect(HOST_JOURNAL_FORBIDDEN.test(row.agentMessage)).toBe(false);
      expect(row.agentMessage.length).toBeGreaterThan(0);
    }
    expect(HOST_STREAM_REJECT_REASONS.has("connect-failed")).toBe(false);
    expect(HOST_STREAM_REJECT_REASONS.has("credential-unusable")).toBe(false);
    expect(journalReasons).toBe(HOST_STREAM_REJECT_REASONS);
    expect(journalCodes).toBe(TURN_SEAM_ERROR_CODES);
    expect(journalReasons.has("missing-step-id")).toBe(true);
    expect(journalReasons.has("route-model-not-admitted")).toBe(true);
    expect(journalReasons.size).toBeGreaterThan(2);
  });

  test("route_model_not_admitted maps to the catalog sentence, never admit-threw", () => {
    const row = catalogByFailureCode(ROUTE_MODEL_NOT_ADMITTED_FAILURE_CODE);
    expect(row?.reason).toBe("route-model-not-admitted");
    expect(catalogAgentMessage("route-model-not-admitted")).toBe(ROUTE_MODEL_NOT_ADMITTED_MESSAGE);
    const mapped = mapAdmitCatch(new BoxRuntimeError("invalid_usage", ROUTE_MODEL_NOT_ADMITTED_MESSAGE, {
      failureCode: ROUTE_MODEL_NOT_ADMITTED_FAILURE_CODE,
    }));
    expect(mapped).toEqual({
      reason: "route-model-not-admitted",
      errorCode: "runtime_config_invalid",
      stage: "admit",
    });
    expect(mapped.reason).not.toBe("admit-threw");
    expect(mapped.reason).not.toBe("admit-refused");
  });

  test("known BoxRuntimeError never lands in admit-threw; unknown throw does", () => {
    expect(mapAdmitCatch(new HostSelectionUnavailableError())).toEqual({
      reason: "selection-unavailable",
      errorCode: "runtime_config_invalid",
      stage: "admit",
    });
    expect(mapAdmitCatch(new BoxRuntimeError("invalid_usage", "other assignment"))).toEqual({
      reason: "admit-refused",
      errorCode: "runtime_config_invalid",
      stage: "admit",
    });
    expect(mapAdmitCatch(new Error("native boom"))).toEqual({
      reason: "admit-threw",
      errorCode: "invalid_envelope",
      stage: "admit",
    });
    expect(catalogByReason("admit-threw")?.mapsFrom).toBe("unknown-throw");
  });

  test("backend stream_invalid maps to Host invalid-stream, not model_error",
    () => {
      expect(mapTerminalReject("stream_invalid", "provider")).toEqual({
        reason: "invalid-stream",
        errorCode: "invalid_stream",
        stage: "normalize",
      });
      expect(mapTerminalReject("invalid_stream", "provider")).toEqual({
        reason: "invalid-stream",
        errorCode: "invalid_stream",
        stage: "normalize",
      });
      expect(mapTerminalReject("parallel_tools", "normalize")).toEqual({
        reason: "terminal-rejected",
        errorCode: "parallel_tools",
        stage: "normalize",
      });
      expect(catalogAgentMessage("invalid-stream")).toBe(INVALID_STREAM_AGENT_MESSAGE);
      expect(catalogByReason("invalid-stream")?.errorCode).toBe("invalid_stream");
    });
});
