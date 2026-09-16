import { expect, test } from "bun:test";
import { streamFailureDiagnostic, WIRE_VERSION } from "@grokbox/runtime-kernel/contract";
import { acceptModeldFrame, clientSessionFor } from "../src/internal/wire/modeld-wire.ts";
import { finishFromTerminal, usageFromTerminal } from "../src/internal/host/stream-codec.ts";
const accepted = () => acceptModeldFrame(clientSessionFor({ method: "run-step" }), { ok: true, method: "run-step", version: WIRE_VERSION, kind: "accepted", bindingId: "binding-a" }).session;
for (const [label, terminal, cause] of [
  ["missing finish", { kind: "terminal", outcome: "ok", bindingId: "binding-a" }, "invalid_terminal"],
  ["unknown finish", { kind: "terminal", outcome: "ok", bindingId: "binding-a", finishReason: "unknown" }, "unsupported_finish_reason"],
  ["length cannot become stop", { kind: "terminal", outcome: "ok", bindingId: "binding-a", finishReason: "length" }, "unsupported_finish_reason"],
  ["different binding", { kind: "terminal", outcome: "ok", bindingId: "binding-b", finishReason: "stop" }, "terminal_binding_mismatch"],
  ["null usage", { kind: "terminal", outcome: "ok", bindingId: "binding-a", finishReason: "stop", usage: { promptTokens: null, completionTokens: 0 } }, "invalid_usage"],
  ["fractional usage", { kind: "terminal", outcome: "ok", bindingId: "binding-a", finishReason: "stop", usage: { promptTokens: 1.5, completionTokens: 0 } }, "invalid_usage"],
] as const) {
  test(`wire refuses ${label} with a bounded detecting-site diagnostic`, () => {
    try { acceptModeldFrame(accepted(), terminal); throw Error("expected failure"); }
    catch (error) { expect(streamFailureDiagnostic(error)).toMatchObject({ normalizeCause: cause, rejectSite: "wire_terminal" }); }
  });
}
test("valid explicit success and measured usage match the accepted binding", () => {
  const terminal = { kind: "terminal", outcome: "ok", bindingId: "binding-a", finishReason: "stop", usage: { promptTokens: 3, completionTokens: 2 } };
  expect(acceptModeldFrame(accepted(), terminal).done).toBe(true);
  expect(finishFromTerminal(terminal)).toMatchObject({ reason: "stop", usage: { totalTokens: 5 } });
});
test("an already bound client never silently adopts a different accepted binding", () => {
  const session = clientSessionFor({ method: "run-step", bindingId: "expected" });
  try { acceptModeldFrame(session, { ok: true, method: "run-step", version: WIRE_VERSION, kind: "accepted", bindingId: "other" }); throw Error("expected failure"); }
  catch (error) { expect(streamFailureDiagnostic(error)?.normalizeCause).toBe("terminal_binding_mismatch"); }
});
for (const event of [{ type: "text_delta", text: 3 }, { type: "tool_start", toolCallId: "x" }, { type: "other" }, { type: "text_delta", text: "x", raw: "SECRET" }]) {
  test(`malformed event ${JSON.stringify(event)} fails before Host acceptance`, () => {
    try { acceptModeldFrame(accepted(), { kind: "event", sequence: 0, event }); throw Error("expected failure"); }
    catch (error) { expect(streamFailureDiagnostic(error)).toMatchObject({ normalizeCause: "invalid_event_shape", rejectSite: "wire_event", wireSequence: 0 }); }
  });
}
test("direct Host terminal helper cannot promote unknown or absent finishes", () => {
  expect(finishFromTerminal({ kind: "terminal", outcome: "ok" })).toBeUndefined();
  expect(finishFromTerminal({ kind: "terminal", outcome: "ok", finishReason: "unknown" })).toBeUndefined();
  expect(usageFromTerminal({ promptTokens: "1", completionTokens: 1 })).toBeUndefined();
  expect(usageFromTerminal({ promptTokens: null, completionTokens: 1 })).toBeUndefined();
});
