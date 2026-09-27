import type { SlicePatch } from "../src/internal/host/profile.ts";
import { sessionEntryReplacement } from "../src/internal/host/live-slices.ts";

export const SYNTHETIC_HOST = `"use strict";
function createSession(sessionOptions) {
  const session = { kind: "official-session", sessionOptions };
  return session;
}
function runTurn(host) {
  const inferenceRequestId = "inv-synth";
  const mainSessionOptions = {
    modelId: "official-main",
    inferenceReason: "main",
  };
  return createSession(mainSessionOptions);
}
module.exports = { createSession, runTurn };
`;

export const SYNTHETIC_SLICES: readonly SlicePatch[] = [
  {
    id: "create-session",
    startAnchor: "function createSession(sessionOptions) {",
    endAnchor: "function runTurn(host) {",
    find: "function createSession(sessionOptions) {",
    replacement: sessionEntryReplacement("function createSession(sessionOptions) {", "undefined"),
  },
  {
    id: "agent-id",
    startAnchor: "const mainSessionOptions = {",
    endAnchor: "return createSession(mainSessionOptions);",
    find: "    modelId: \"official-main\",\n",
    replacement:
      "    agentId: host.getConversationId(),\n    invocationId: inferenceRequestId,\n    modelId: \"official-main\",\n",
  },
];
