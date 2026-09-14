import { sha256Text } from "@grokbox/runtime-kernel/hash";
import { ENVELOPE_SLICE_IDS } from "../src/internal/ops/host-seam/envelope-windows.ts";
import type { PatchProfile, SlicePatch } from "../src/internal/host/profile.ts";

export function hex64(ch: string): string {
  return ch.repeat(64);
}

function contractPrefix(): string {
  return `"use strict";
function createSession(sessionOptions) {
  return null;
}
function runTurn(host) {
  return host;
}
const mainSessionOptions = {
  modelId: "toy"
};
void { agentId: host.getConversationId() };
function createCursorInferencePromptSession() {}
// keep the first-hit prompt-session 80-char window inside this prefix
`;
}

export function toyEnvelope(insertion: string): { source: string; profile: PatchProfile } {
  const slices: SlicePatch[] = [];
  let body = "";
  for (const id of ENVELOPE_SLICE_IDS) {
    if (id === "compact-register" || id === "managed-step-error-scope") continue;
    const start = `__START_${id}__`;
    const end = `__END_${id}__`;
    const find = `__FIND_${id}__`;
    body += `${start}\n${find}\n${end}\n`;
    slices.push({ id, startAnchor: start, endAnchor: end, find, replacement: `${find}patched` });
  }
  const compactFind = "__FIND_compact-register__";
  const stepFind = "__FIND_managed-step-error-scope__";
  const nested = `__START_managed-step-error-scope__
preamble
__START_compact-register__
${compactFind}
${insertion}__END_compact-register__
${stepFind}
__END_managed-step-error-scope__
`;
  body += nested;
  slices.push(
    {
      id: "compact-register",
      startAnchor: "__START_compact-register__",
      endAnchor: "__END_compact-register__",
      find: compactFind,
      replacement: `${compactFind}patched`,
    },
    {
      id: "managed-step-error-scope",
      startAnchor: "__START_managed-step-error-scope__",
      endAnchor: "__END_managed-step-error-scope__",
      find: stepFind,
      replacement: `${stepFind}patched`,
    },
  );
  const source = `${contractPrefix()}${body}`;
  return {
    source,
    profile: {
      profileId: "toy-envelope",
      sourceSha256: sha256Text(source),
      transformedSourceSha256: hex64("0"),
      slices,
    },
  };
}
