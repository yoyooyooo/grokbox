import { describe, expect, test } from "bun:test";
import { WIRE_VERSION, WireError, contextSnapshotBody } from "@grokbox/runtime-kernel/contract";
import { computeSnapshotDigest } from "@grokbox/runtime-kernel/hash";
import { acceptModeldFrame, clientSessionFor, decodeModeldFrame, encodeModeldFrame, parseModeldRequest, parseV3Request, parseV4ControlFrame } from "../src/internal/wire/modeld-wire.ts";

describe("modeld v4 wire", () => {
  test("round-trips health and rejects v3/v2, extra keys, malformed utf-8", () => {
    const encoded = encodeModeldFrame({ version: WIRE_VERSION, method: "health" });
    const decoded = decodeModeldFrame(encoded);
    expect(decoded && "value" in decoded ? parseModeldRequest(decoded.value) : undefined).toEqual({ method: "health" });
    expect(() => parseModeldRequest({ version: 2, method: "health" })).toThrow(WireError);
    expect(() => parseModeldRequest({ version: 3, method: "health" })).toThrow(WireError);
    expect(() => parseV3Request({ version: 3, method: "health" })).toThrow(WireError);
    expect(() => parseModeldRequest({ version: WIRE_VERSION, method: "health", extra: true })).toThrow(WireError);
    const bad = Buffer.from(encoded);
    bad[5] = 0xff;
    const malformed = decodeModeldFrame(bad);
    expect(malformed && "error" in malformed ? malformed.error : undefined).toBe("malformed");
  });

  test("rejects unknown method and oversized frames", () => {
    expect(() => parseModeldRequest({ version: WIRE_VERSION, method: "complete" })).toThrow(WireError);
    const huge = Buffer.alloc(8);
    huge.writeUInt32BE(9_000_000, 0);
    expect(decodeModeldFrame(huge)).toEqual({ error: "too-large" });
  });

  test("rejects non-string bindingId and extra snapshot keys", () => {
    const base = {
      version: WIRE_VERSION,
      method: "run-step",
      hostEpoch: { compile: "c", source: "s", profile: "p", hostIdentity: "h", bridgeDigest: "b", wireVersion: "v4" },
      serviceEpoch: { incarnationId: "svc" },
      agentId: "a",
      turnId: "t",
      stepId: "s1",
      selection: { agentId: "a", modelId: "stub/echo", selectionRevision: "0".repeat(64) },
      snapshot: {
        version: 1,
        profileId: "p",
        abiIdentity: "abi",
        systemMessages: [{ role: "system", content: "r" }],
        messages: [{ role: "user", content: "hi" }],
        tools: [],
        snapshotDigest: "0".repeat(64),
      },
    };
    expect(() => parseModeldRequest({ ...base, bindingId: 123 })).toThrow(WireError);
    expect(() => parseModeldRequest({ ...base, snapshot: { ...base.snapshot, extra: true } })).toThrow(WireError);
  });

  test("client response SM rejects version-2 garbage terminal", () => {
    const session = clientSessionFor({ version: WIRE_VERSION, method: "health" });
    expect(() => acceptModeldFrame(session, { kind: "terminal", outcome: "ok", version: 2, garbage: true })).toThrow(WireError);
  });

  test("compact-request and resume-step are first-class v4 control frames", () => {
    expect(() => parseModeldRequest({ version: 4, method: "compact-request" })).toThrow(WireError);
    const compact = parseV4ControlFrame({
      version: 4,
      method: "compact-request",
      agentId: "a",
      turnId: "t",
      stepId: "s1",
      bindingId: "b",
      selectionRevision: "r",
      recoveryNonce: "n",
      deadlineMs: 5_000,
    });
    expect(compact).toMatchObject({ method: "compact-request", recoveryNonce: "n", deadlineMs: 5_000 });
    const body = contextSnapshotBody({
      version: 1,
      profileId: "p",
      abiIdentity: "abi",
      systemMessages: [{ role: "system", content: "r" }],
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      options: {},
    });
    const snapshot = { ...body, snapshotDigest: computeSnapshotDigest(body) };
    const resume = parseV4ControlFrame({
      version: 4,
      method: "resume-step",
      agentId: "a",
      turnId: "t",
      stepId: "s1",
      bindingId: "b",
      selectionRevision: "r",
      recoveryNonce: "n",
      snapshot,
    });
    expect(resume.method).toBe("resume-step");
    expect(() => parseV4ControlFrame({ version: 4, method: "run-step" })).toThrow(WireError);
    const events = acceptModeldFrame({ method: "run-step", phase: "events", sequence: 0 }, {
      version: 4,
      method: "compact-request",
      agentId: "a",
      turnId: "t",
      stepId: "s1",
      bindingId: "b",
      selectionRevision: "r",
      recoveryNonce: "n",
      deadlineMs: 5_000,
    });
    expect(events.done).toBe(false);
    expect(events.control).toMatchObject({ method: "compact-request", recoveryNonce: "n" });
    expect(events.session).toEqual({ method: "run-step", phase: "events", sequence: 0 });
  });

  test("events-phase v4 terminal is not parsed as compact-request", () => {
    const start = acceptModeldFrame({ method: "run-step", phase: "start", sequence: 0 }, {
      ok: true, method: "run-step", kind: "accepted", version: WIRE_VERSION, bindingId: "b",
    });
    expect(start.done).toBe(false);
    expect(start.control).toBeUndefined();
    const terminal = acceptModeldFrame(start.session, {
      kind: "terminal", outcome: "ok", bindingId: "b", finishReason: "stop", version: WIRE_VERSION,
    });
    expect(terminal.done).toBe(true);
    expect(terminal.control).toBeUndefined();
  });
});
