import { describe, expect, test } from "bun:test";
import {
  copyInferenceTuple,
  correlateInferenceTuple,
  journalRoleAllows,
  projectRuntimeStatus,
  projectSafeReason,
  STATUS_SCHEMA_VERSION,
  type StatusEvidence,
} from "@grokbox/runtime-kernel/status";

const NOW = "2026-09-08T00:00:00.000Z";
const SECRET = "sk-live-SENTINEL_SECRET";
const PROMPT = "SENTINEL_PROMPT do not leak";
const ERROR_BODY = "provider error body SENTINEL_ERROR";

function observed<T>(source: string, value: T | null, gap: StatusEvidence["desired"]["gap"] = null): { source: string; observedAt: string; gap: StatusEvidence["desired"]["gap"]; value: T | null } {
  return { source, observedAt: NOW, gap, value };
}

function base(overrides: Partial<StatusEvidence> = {}): StatusEvidence {
  return {
    now: NOW,
    durableRoot: "/workspace/.grokbox/box-runtime",
    desired: observed("state/desired.json", "identity"),
    attestation: observed("attestation.json", { coverage: "attested", mode: "identity" }),
    coordinator: observed("state/coordinator.json", { circuit: "closed", circuitReason: null }),
    operationJournal: observed("ops/adopt.json", { pending: false, phase: "attested" }),
    modeld: observed("modeld.sock", { required: false, ready: false }),
    controllerLiveness: { source: "controller", observedAt: null, gap: "missing", value: null },
    bridgeHost: observed("processes", {
      actual: "identity",
      origin: "grokbox-attested",
      coverage: "attested",
      reason: null,
    }),
    hostDelivery: { source: "log/events.ndjson", observedAt: null, gap: "missing", value: null },
    ...overrides,
  };
}

describe("status facets projector", () => {
  test("attested + open circuit + no pending keeps circuit, inhibits mutation, liveness unknown", () => {
    const status = projectRuntimeStatus(base({
      coordinator: observed("state/coordinator.json", { circuit: "open", circuitReason: "unsupported_bundle" }),
    }));
    expect(status.schemaVersion).toBe(STATUS_SCHEMA_VERSION);
    expect(status.circuit.value).toEqual({ state: "open", reason: "unsupported_bundle" });
    expect(status.facets.bridge.value?.coverage).toBe("attested");
    expect(status.facets.bridge.value?.origin).toBe("grokbox-attested");
    expect(status.facets.mutation.value).toEqual({
      inhibited: true,
      allowed: false,
      reason: "unsupported_bundle",
    });
    expect(status.facets.controller.value?.liveness).toBe("unknown");
    expect(status.facets.recovery.value?.state).toBe("clear");
    expect(JSON.stringify(status)).not.toContain("degraded");
    expect(status).not.toHaveProperty("watchdog");
  });

  test("open circuit is not cleared and is not a green aggregate", () => {
    const status = projectRuntimeStatus(base({
      coordinator: observed("state/coordinator.json", { circuit: "open", circuitReason: "budget" }),
      attestation: observed("attestation.json", { coverage: "attested", mode: "route" }),
    }));
    expect(status.circuit.value?.state).toBe("open");
    expect(status.facets.mutation.value?.inhibited).toBe(true);
    expect(status.facets.bridge.value?.coverage).not.toBe("none");
    expect(status.facets.controller.value?.liveness).not.toBe("alive");
  });

  test("pending journal is recovery-required and attestation does not cover it", () => {
    const status = projectRuntimeStatus(base({
      attestation: observed("attestation.json", { coverage: "attested", mode: "identity" }),
      operationJournal: observed("ops/adopt.json", { pending: true, phase: "commit-attestation" }),
    }));
    expect(status.facets.recovery.value).toEqual({ state: "recovery-required", pending: true });
    expect(status.facets.recovery.source).toBe("ops/adopt.json");
    expect(status.facets.bridge.value?.coverage).toBe("attested");
  });

  test("invalid and unavailable journals are unknown with source, not old-attestation green", () => {
    const invalid = projectRuntimeStatus(base({
      operationJournal: { source: "ops/adopt.json", observedAt: NOW, gap: "invalid", value: null },
    }));
    expect(invalid.facets.recovery.value?.state).toBe("unknown");
    expect(invalid.facets.recovery.gap).toBe("invalid");
    expect(invalid.facets.recovery.source).toBe("ops/adopt.json");

    const unavailable = projectRuntimeStatus(base({
      operationJournal: { source: "ops/adopt.json", observedAt: null, gap: "unavailable", value: null },
    }));
    expect(unavailable.facets.recovery.value?.state).toBe("unknown");
    expect(unavailable.facets.recovery.gap).toBe("unavailable");
  });

  test("modeld health success is modeld ready only", () => {
    const status = projectRuntimeStatus(base({
      modeld: observed("modeld.sock", { required: true, ready: true }),
      controllerLiveness: { source: "controller", observedAt: null, gap: "missing", value: null },
      attestation: { source: "attestation.json", observedAt: null, gap: "missing", value: null },
      bridgeHost: observed("processes", {
        actual: "official",
        origin: "official",
        coverage: "none",
        reason: null,
      }),
    }));
    expect(status.facets.modeld.value).toEqual({ required: true, ready: true });
    expect(status.facets.controller.value?.liveness).toBe("unknown");
    expect(status.facets.bridge.value?.coverage).not.toBe("attested");
    expect(status.facets.hostDelivery.value?.kind).toBe("not_observed");
  });

  test("host and model terminals stay stage facts, never SendToUser or App delivery", () => {
    const host = projectRuntimeStatus(base({
      hostDelivery: observed("log/events.ndjson", {
        kind: "host_terminal",
        tuple: {
          hostId: "h1", agentId: "a1", turnId: "t1", stepId: "s1",
          serviceEpoch: "e1", binding: "b1", attempt: "1",
        },
      }),
    }));
    expect(host.facets.hostDelivery.value?.kind).toBe("host_terminal");
    expect(host.facets.hostDelivery.value?.correlated).toBe(true);
    const text = JSON.stringify(host);
    expect(text).not.toContain("SendToUser");
    expect(text).not.toContain("app_displayed");
    expect(text).not.toContain("appDisplayed");

    const model = projectRuntimeStatus(base({
      hostDelivery: observed("log/events.ndjson", {
        kind: "model_terminal",
        tuple: { agentId: "a1" },
      }),
    }));
    expect(model.facets.hostDelivery.value?.kind).toBe("model_terminal");
    expect(model.facets.hostDelivery.value?.correlated).toBe(false);
  });

  test("missing, truncated, and unsupported events are gaps, not zero calls", () => {
    const missing = projectRuntimeStatus(base({
      hostDelivery: { source: "log/events.ndjson", observedAt: null, gap: "missing", value: null },
    }));
    expect(missing.facets.hostDelivery.gap).toBe("missing");
    expect(missing.facets.hostDelivery.value?.kind).toBe("not_observed");
    expect(JSON.stringify(missing)).not.toMatch(/zero[- ]calls|no calls happened/i);

    const truncated = projectRuntimeStatus(base({
      hostDelivery: { source: "log/events.ndjson", observedAt: null, gap: null, value: null },
      eventsTruncated: true,
    }));
    expect(truncated.facets.hostDelivery.gap).toBe("truncated");

    const unsupported = projectRuntimeStatus(base({
      hostDelivery: observed("log/events.ndjson", {
        kind: "host_terminal",
        tuple: { agentId: "a1" },
      }),
      eventsUnsupported: true,
    }));
    expect(unsupported.facets.hostDelivery.gap).toBe("unsupported_schema");
  });

  test("incomplete correlation is unknown and does not invent provider ids", () => {
    const result = correlateInferenceTuple({ agentId: "a1", turnId: "provider-self-id" });
    expect(result.state).toBe("unknown");
    if (result.state !== "unknown") throw new Error("expected unknown");
    expect(result.missing).toContain("stepId");
    expect(result.missing).toContain("serviceEpoch");
  });

  test("tuple copy drops extra secret fields; unsafe reasons become unknown", () => {
    const copied = copyInferenceTuple({
      hostId: "h1", agentId: "a1", turnId: "t1", stepId: "s1",
      serviceEpoch: "e1", binding: "b1", attempt: "1",
      authorization: SECRET, providerError: ERROR_BODY, invocationId: "inv-should-not-copy",
    });
    expect(copied).toEqual({
      hostId: "h1", agentId: "a1", turnId: "t1", stepId: "s1",
      serviceEpoch: "e1", binding: "b1", attempt: "1",
    });
    expect(JSON.stringify(copied)).not.toContain(SECRET);
    expect(copied).not.toHaveProperty("authorization");
    expect(copied).not.toHaveProperty("invocationId");
    const correlated = correlateInferenceTuple({
      ...copied,
      authorization: SECRET,
    } as never);
    expect(correlated.state).toBe("correlated");
    if (correlated.state === "correlated") {
      expect(JSON.stringify(correlated.tuple)).not.toContain(SECRET);
      expect(correlated.tuple).not.toHaveProperty("authorization");
    }
    expect(projectSafeReason("unsupported_bundle")).toBe("unsupported_bundle");
    expect(projectSafeReason(SECRET)).toBeNull();
    expect(projectSafeReason(PROMPT)).toBeNull();
    expect(projectSafeReason("SENTINEL_ERROR_BODY")).toBeNull();
    const leaked = projectRuntimeStatus(base({
      coordinator: observed("state/coordinator.json", { circuit: "open", circuitReason: SECRET }),
      hostDelivery: observed("log/events.ndjson", {
        kind: "host_terminal",
        tuple: { ...copied, authorization: SECRET, providerError: ERROR_BODY } as never,
      }),
    }));
    const text = JSON.stringify(leaked);
    expect(leaked.circuit.value?.reason).toBeNull();
    expect(leaked.facets.mutation.value?.reason).toBe("circuit_open");
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(PROMPT);
    expect(text).not.toContain(ERROR_BODY);
    expect(text).not.toContain("sk-live");
    expect(leaked.facets.hostDelivery.value?.tuple).not.toHaveProperty("authorization");
  });

  test("truncated history keeps the visible terminal and still reports truncated gap", () => {
    const status = projectRuntimeStatus(base({
      hostDelivery: observed("log/events.ndjson", {
        kind: "host_rejected",
        tuple: { agentId: "a1", turnId: "t1" },
      }),
      eventsTruncated: true,
    }));
    expect(status.facets.hostDelivery.value?.kind).toBe("host_rejected");
    expect(status.facets.hostDelivery.gap).toBe("truncated");
  });

  test("journal roles: host/modeld/control allowlists and watchdog cannot append", () => {
    expect(journalRoleAllows("host", "host_stream_rejected")).toBe(true);
    expect(journalRoleAllows("host", "circuit_open")).toBe(false);
    expect(journalRoleAllows("modeld", "model_step_terminal")).toBe(true);
    expect(journalRoleAllows("modeld", "host_stream_rejected")).toBe(false);
    expect(journalRoleAllows("control", "census")).toBe(true);
    expect(journalRoleAllows("control", "turn_seam_terminal")).toBe(false);
    expect(journalRoleAllows("watchdog", "census")).toBe(false);
    expect(journalRoleAllows("watchdog", "host_stream_rejected")).toBe(false);
  });
});
