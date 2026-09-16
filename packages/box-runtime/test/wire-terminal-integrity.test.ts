import { describe, expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WIRE_VERSION, WireError, streamFailureDiagnostic } from "@grokbox/runtime-kernel/contract";
import { acceptModeldFrame, clientSessionFor, encodeModeldFrame, type ClientSession } from "../src/internal/wire/modeld-wire.ts";
import { finishFromTerminal } from "../src/internal/host/stream-codec.ts";
import { requestModeld, streamModeld } from "../src/internal/host/modeld-client.node.ts";

const accepted = { ok: true, method: "run-step", kind: "accepted", version: WIRE_VERSION, bindingId: "binding-a" };
const stop = { kind: "terminal", outcome: "ok", bindingId: "binding-a", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1 } };
function start(): ClientSession { return acceptModeldFrame(clientSessionFor({ method: "run-step" }), accepted).session; }

describe("strict current terminal, binding, usage and event contract", () => {
  for (const [label, terminal, cause] of [
    ["missing finish", { kind: "terminal", outcome: "ok", bindingId: "binding-a" }, "invalid_terminal"],
    ["unknown finish", { ...stop, finishReason: "unknown" }, "unsupported_finish_reason"],
    ["provider length is not canonical success", { ...stop, finishReason: "length" }, "unsupported_finish_reason"],
    ["wrong binding", { ...stop, bindingId: "binding-b" }, "terminal_binding_mismatch"],
    ["empty binding", { ...stop, bindingId: "" }, "terminal_binding_mismatch"],
    ["numeric string is not measured tokens", { ...stop, usage: { promptTokens: "1", completionTokens: 1 } }, "invalid_usage"],
    ["negative tokens", { ...stop, usage: { promptTokens: -1, completionTokens: 1 } }, "invalid_usage"],
    ["unknown usage body", { ...stop, usage: { promptTokens: 1, completionTokens: 1, raw: "PRIVATE" } }, "invalid_usage"],
  ] as const) {
    test(label, () => {
      try { acceptModeldFrame(start(), terminal); throw Error("expected rejection"); }
      catch (error) { expect(error).toBeInstanceOf(WireError); expect(streamFailureDiagnostic(error)?.normalizeCause).toBe(cause); }
    });
  }
  test("the Host mapper cannot independently restore the permissive default-stop bug", () => {
    for (const reason of [undefined, "unknown", "length", false]) expect(finishFromTerminal({ ...stop, finishReason: reason })).toBeUndefined();
    expect(finishFromTerminal(stop)).toMatchObject({ reason: "stop", usage: { totalTokens: 2 } });
  });
  test("an existing request binding must match the accepted binding", () => {
    const session = clientSessionFor({ method: "run-step", bindingId: "another-binding" });
    expect(() => acceptModeldFrame(session, accepted)).toThrow(WireError);
  });
  test("malformed or out-of-sequence canonical events are visible failures", () => {
    for (const event of [{ type: "future" }, { type: "text_delta" }, { type: "tool_start", toolCallId: "one", toolName: "" },
      { type: "backend_finish", finishReason: "stop" }, { type: "text_delta", text: "ok", private: "PRIVATE" }]) {
      expect(() => acceptModeldFrame(start(), { kind: "event", sequence: 0, event })).toThrow(WireError);
    }
    expect(() => acceptModeldFrame(start(), { kind: "event", sequence: 1, event: { type: "text_delta", text: "x" } })).toThrow(WireError);
  });
  test("fragment counts are not a lifetime quota; the explicit terminal remains mandatory", () => {
    let state = start();
    for (let sequence = 0; sequence < 20_000; sequence++) {
      state = acceptModeldFrame(state, { kind: "event", sequence, event: { type: "text_delta", text: "x" } }).session;
    }
    expect(state).toMatchObject({ sequence: 20_000 });
    expect(acceptModeldFrame(state, stop).done).toBe(true);
    expect(() => acceptModeldFrame(state, { ...stop, finishReason: "unknown" })).toThrow(WireError);
  });
});

async function peer(handler: (socket: Socket) => void) {
  const root = await mkdtemp(join(tmpdir(), "grokbox-wire-terminal-"));
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.on("error", () => undefined); socket.once("close", () => sockets.delete(socket));
    socket.once("data", () => handler(socket));
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(join(root, "modeld.sock"), resolve); });
  return { root, async close() {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  } };
}

describe("real Unix decoder EOF and local transport side", () => {
  test("coalesced accepted/event/terminal followed immediately by EOF is not lost", async () => {
    const server = await peer(socket => socket.end(Buffer.concat([
      encodeModeldFrame(accepted), encodeModeldFrame({ kind: "event", sequence: 0, event: { type: "text_delta", text: "owned" } }), encodeModeldFrame(stop),
    ])));
    try {
      const frames = await requestModeld(server.root, { method: "run-step", version: WIRE_VERSION }, 1000);
      expect(frames).toHaveLength(3);
      expect(frames.at(-1)).toEqual(stop);
    } finally { await server.close(); }
  });
  test("EOF without terminal is side-qualified and cannot be a successful stream", async () => {
    const server = await peer(socket => socket.end(encodeModeldFrame(accepted)));
    try {
      await expect(requestModeld(server.root, { method: "run-step", version: WIRE_VERSION }, 1000)).rejects.toMatchObject({ side: "host_modeld_ipc", reason: "peer_eof" });
    } finally { await server.close(); }
  });
  test("a blocked stream honors caller cancellation and releases its socket", async () => {
    const server = await peer(socket => socket.write(encodeModeldFrame(accepted)));
    const ac = new AbortController();
    try {
      const iterator = streamModeld(server.root, { method: "run-step", version: WIRE_VERSION }, { signal: ac.signal, timeoutMs: 1000 })[Symbol.asyncIterator]();
      expect((await iterator.next()).value).toEqual(accepted);
      const next = iterator.next(); ac.abort();
      await expect(next).rejects.toMatchObject({ side: "host_modeld_ipc", reason: "caller_abort" });
    } finally { await server.close(); }
  });
  test("bytes after terminal in the same read are rejected rather than hidden", async () => {
    const server = await peer(socket => socket.end(Buffer.concat([encodeModeldFrame(accepted), encodeModeldFrame(stop), encodeModeldFrame(stop)])));
    try {
      await expect(requestModeld(server.root, { method: "run-step", version: WIRE_VERSION }, 1000)).rejects.toMatchObject({ code: "extra_keys" });
    } finally { await server.close(); }
  });
});
