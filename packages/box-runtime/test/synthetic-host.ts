import type { SlicePatch } from "../src/transform.ts";

export const SYNTHETIC_HOST = `"use strict";
function createSession(sessionOptions) {
  const session = { kind: "official-session", sessionOptions };
  return session;
}
function runTurn(host) {
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
    find: "  return session;\n",
    replacement:
      "  const __grokbox_hook = globalThis[Symbol.for(\"grokbox.box-runtime.route-session.v1\")];\n  return typeof __grokbox_hook === \"function\" ? __grokbox_hook({ originalSession: session, sessionOptions, agentId: sessionOptions.agentId }) : session;\n",
  },
  {
    id: "agent-id",
    startAnchor: "const mainSessionOptions = {",
    endAnchor: "return createSession(mainSessionOptions);",
    find: "    modelId: \"official-main\",\n",
    replacement: "    agentId: host.getConversationId(),\n    modelId: \"official-main\",\n",
  },
];
