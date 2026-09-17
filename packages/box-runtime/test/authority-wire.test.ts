import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { WIRE_VERSION, WireError, projectAuthorityProgress, type AuthorityProgress } from "@grokbox/runtime-kernel/contract";
import { acceptModeldFrame, clientSessionFor, encodeModeldFrame, decodeModeldFrame, parseModeldRequest } from "../src/internal/wire/modeld-wire.ts";
import { streamModeld } from "../src/internal/host/modeld-client.node.ts";
import { modeldRootId, observeModeldService } from "../src/internal/wire/modeld-probe.node.ts";
const progress: AuthorityProgress = { version: 1, policyId: "strict-observation-v1", phase: "waiting", checkpoint: "admission", check: 1, elapsedMs: 0, cumulativeMs: 0, remainingMs: 10000, retries: 0 };
const frame = (sequence = 0, authority = progress) => ({ kind: "authority", version: WIRE_VERSION, sequence, authority });

test("pre-admission authority controls preserve independent ordering and cannot replace accepted or terminal", () => {
  let session = clientSessionFor({ method: "run-step" });
  session = acceptModeldFrame(session, frame()).session;
  expect(session).toMatchObject({ phase: "start", sequence: 0, authoritySequence: 1 });
  expect(() => acceptModeldFrame(session, { kind: "event", sequence: 0, event: { type: "text_delta", text: "not admitted" } })).toThrow(WireError);
  session = acceptModeldFrame(session, { ok: true, method: "run-step", kind: "accepted", version: WIRE_VERSION, bindingId: "binding" }).session;
  expect(session).toMatchObject({ phase: "events", sequence: 0, authoritySequence: 1 });
  session = acceptModeldFrame(session, frame(1, { ...progress, phase: "authorized" })).session;
  session = acceptModeldFrame(session, { kind: "event", sequence: 0, event: { type: "text_delta", text: "model output" } }).session;
  expect(session).toMatchObject({ sequence: 1, authoritySequence: 2 });
  expect(acceptModeldFrame(session, { kind: "terminal", outcome: "ok", bindingId: "binding", finishReason: "stop" }).done).toBe(true);
});

test("old execution versions and malformed authority controls cannot negotiate permission", () => {
  for (const version of [3, 4, 5, 6]) expect(() => parseModeldRequest({ method: "health", version })).toThrow(WireError);
  const session = clientSessionFor({ method: "run-step" });
  for (const bad of [ { ...frame(), version: 5 }, { ...frame(), sequence: 1 },
    frame(0, { ...progress, remainingMs: -1 }), frame(0, { ...progress, retries: 3 }),
    { ...frame(), authority: { ...progress, phase: "run_anything" } }, { ...frame(), prompt: "PRIVATE" } ]) {
    expect(() => acceptModeldFrame(session, bad)).toThrow(WireError);
  }
  const next = acceptModeldFrame(session, frame()).session;
  expect(() => acceptModeldFrame(next, frame())).toThrow(WireError);
});

test("safe authority projections omit raw diagnostics and do not invoke getters", () => {
  let getter = 0;
  const result = projectAuthorityProgress({ ...progress, secret: "PRIVATE", evidenceId: "not-a-uuid",
    diagnostic: { reason: "ownership_read_unavailable", message: "PRIVATE", get response() { getter++; throw Error("PRIVATE"); } } });
  expect(getter).toBe(0); expect(JSON.stringify(result)).not.toContain("PRIVATE"); expect(result?.evidenceId).toBeUndefined();
});

test("EOF following only authority progress is incomplete, never a successful empty model answer", async () => {
  const root = await mkdtemp(join(tmpdir(), "authority-eof-"));
  const server = createServer(socket => socket.once("data", () => socket.end(encodeModeldFrame(frame()))));
  await new Promise<void>(resolve => server.listen(join(root, "modeld.sock"), resolve));
  try {
    const seen: unknown[] = [];
    let error: unknown;
    try { for await (const value of streamModeld(root, { method: "run-step" }, { timeoutMs: 1000 })) seen.push(value); }
    catch (e) { error = e; }
    expect(seen).toHaveLength(1); expect(error).toBeDefined();
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

for (const version of [5, 6]) test(`v${version} identity stays observable but cannot execute v7`, async () => {
  const root = await mkdtemp(join(tmpdir(), "authority-v5-probe-")), generation = randomUUID();
  const server = createServer(socket => socket.once("data", data => {
    const decoded = decodeModeldFrame(typeof data === "string" ? Buffer.from(data) : data);
    if (!decoded || "error" in decoded) return socket.end();
    const request = decoded.value as { version: number; method: string };
    if (request.version !== version || request.method !== "service-info") return socket.end();
    socket.end(encodeModeldFrame({ ok: true, method: "service-info", version, serverGeneration: generation, rootId: modeldRootId(root, root) }));
  }));
  await new Promise<void>(resolve => server.listen(join(root, "modeld.sock"), resolve));
  try {
    expect(await observeModeldService(root, root)).toMatchObject({ ready: false, wireVersion: version, expectedWireVersion: 7,
      protocolCompatible: false, scope: "matched", serviceEpoch: generation });
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});
