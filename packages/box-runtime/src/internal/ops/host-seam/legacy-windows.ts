import { countOccurrences } from "@grokbox/runtime-kernel/hash";

export const LEGACY_WINDOW_SELECTOR_VERSION = "hso-0.legacy-window.v1";
export const LEGACY_WINDOW_NAMES = ["create-session", "session-options", "agent-id", "prompt-session"] as const;
export type LegacyWindowName = (typeof LEGACY_WINDOW_NAMES)[number];

export type LegacyNeedleHit = {
  needleId: string;
  needle: string;
  hitCount: number;
  offsets: number[];
};

export type LegacyWindowRow = {
  name: `contract:${LegacyWindowName}`;
  selectorVersion: typeof LEGACY_WINDOW_SELECTOR_VERSION;
  evidenceKind: "legacy-window";
  /** Auxiliary only. Never "unchanged"; missing/multi-match stay unknown. */
  patchImpact: "unknown";
  needles: LegacyNeedleHit[];
  hitCount: number;
};

const SELECTORS: Record<LegacyWindowName, Array<{ needleId: string; needle: string }>> = {
  "create-session": [
    { needleId: "fn-createSession-sessionOptions", needle: "function createSession(sessionOptions)" },
    { needleId: "method-createSession-onRequestId", needle: "createSession(onRequestId, sessionOptions)" },
  ],
  "session-options": [
    { needleId: "mainSessionOptions", needle: "const mainSessionOptions = {" },
  ],
  "agent-id": [
    { needleId: "conversationId-getter", needle: "agentId: host.getConversationId()" },
  ],
  "prompt-session": [
    { needleId: "createCursorInferencePromptSession", needle: "function createCursorInferencePromptSession" },
  ],
};

function allOffsets(haystack: string, needle: string): number[] {
  const offsets: number[] = [];
  if (needle.length === 0) return offsets;
  let from = 0;
  while (from <= haystack.length) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) break;
    offsets.push(index);
    from = index + needle.length;
  }
  return offsets;
}

/** Four old contract windows as auxiliary evidence. Counts every hit; never first-hit patchImpact.
 * YELLOW: this is not envelope green. 19-slice window drift is envelopeDrift, not these rows. */
export function observeLegacyWindows(source: string): LegacyWindowRow[] {
  return LEGACY_WINDOW_NAMES.map((name) => {
    const needles = SELECTORS[name].map((selector) => {
      const offsets = allOffsets(source, selector.needle);
      return {
        needleId: selector.needleId,
        needle: selector.needle,
        hitCount: countOccurrences(source, selector.needle),
        offsets,
      };
    });
    return {
      name: `contract:${name}` as const,
      selectorVersion: LEGACY_WINDOW_SELECTOR_VERSION,
      evidenceKind: "legacy-window" as const,
      patchImpact: "unknown" as const,
      needles,
      hitCount: needles.reduce((sum, needle) => sum + needle.hitCount, 0),
    };
  });
}
