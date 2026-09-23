import { expect, test } from "bun:test";
import { messageEntry, messageDelivery, messageDeliveryState, type MessageEntry, type MessageDelivery } from "../src/message-contract.ts";
const installation = "11111111-1111-4111-8111-111111111111", bot = "22222222-2222-4222-8222-222222222222";
const request = "33333333-3333-4333-8333-333333333333", nonce = "44444444-4444-4444-8444-444444444444";
const echo: MessageEntry = { id: "u", kind: "message", requestId: "native-request", clientNonce: nonce,
  isStreaming: null, deliveryEvidence: "not-observed", role: "user", text: "input", observedAtMs: 1, rootId: null, truncated: false };
const reply: MessageEntry = { ...echo, id: "d", kind: "send-message", role: "assistant", text: "reply", clientNonce: null, deliveryEvidence: "persisted-text" };
function fixture(): MessageDelivery {
  const association = { queue: "not-observed", run: "not-observed", turn: "not-observed", step: "not-observed", terminal: "not-observed", delivery: "response-observed" } as const;
  return { operation: { schemaVersion: 1, installationId: installation, requestId: request,
    operationRef: `message-operation:${installation}:${bot}:${request}`, submissionRef: `submission:${installation}:${bot}:${request}`,
    botRef: `bot:${installation}:${bot}`, clientNonce: nonce, textSha256: "a".repeat(64), state: "accepted", acceptedAtMs: 1,
    nativeGeneration: "b".repeat(64), nativeIdentity: { scopeId: "c".repeat(64), serverId: "owned", harness: "box" }, nativeReceipt: { accepted: true }, association: { ...association, delivery: "unknown" }, coverage: "native-submission" },
    state: "response-observed", observedAtMs: 2, entries: [echo, reply], source: { generation: "b".repeat(64), pid: 1, startedAt: 1 }, association, coverage: "native-transcript-window" };
}
test("persisted-text keeps absent streaming evidence null and does not invent run completion", () => {
  expect(messageEntry(reply)).toBe(true); expect(reply.isStreaming).toBeNull();
  expect(messageDelivery(fixture(), installation, request)).toBe(true);
});
for (const change of [{ kind: "message" }, { role: "user" }, { isStreaming: true }, { text: null }, { id: "" }])
  test(`invalid persisted-text evidence rejects ${JSON.stringify(change)}`, () => expect(messageEntry({ ...reply, ...change })).toBe(false));
test("delivery validator cannot accept a successful state without its original join", () => {
  for (const change of [{ entries: [] }, { entries: [reply] }, { entries: [echo, { ...reply, requestId: "foreign" }] }, { source: null }, { coverage: "native-source-unavailable" }])
    expect(messageDelivery({ ...fixture(), ...change }, installation, request)).toBe(false);
});
test("ambiguous nonce and ordinary assistant output do not constitute delivery", () => {
  expect(messageDeliveryState([echo, { ...reply, kind: "message", deliveryEvidence: "not-observed" }], nonce)).toBe("recorded");
  expect(messageDeliveryState([echo, { ...echo, id: "u2", requestId: "foreign" }, reply], nonce)).toBe("unknown");
  expect(messageDeliveryState([{ ...echo, requestId: null }, reply], nonce)).toBe("recorded");
});
