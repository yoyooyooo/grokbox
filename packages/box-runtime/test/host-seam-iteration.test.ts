import { describe, expect, test } from "bun:test";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import { iterateHostSeamShape } from "../src/internal/ops/host-seam/iteration.ts";
import { structuralShapeSync } from "../src/internal/ops/host-seam/shape.ts";
import { LIVE_SHAPED_HOST } from "./live-shaped-host.ts";

const DECOY = LIVE_SHAPED_HOST.replace(
  "const api = {",
  `const decoy = {
  createSession(onRequestId, sessionOptions) {
    return createCursorInferencePromptSession(sessionOptions);
  },
};
const api = {`,
);

describe("HSO-4 bounded offline iteration", () => {
  test("unique LIVE_SHAPED_HOST pair verifies offline without writes", () => {
    const first = iterateHostSeamShape({ source: LIVE_SHAPED_HOST });
    expect(first.status).toBe("verified_offline");
    expect(first.round).toBe(1);
    expect(first.writes).toBe(0);
    expect(first.hostSignals).toBe(0);
    expect(first.unauthorizedCodeWrite).toBe(false);
  });

  test("wrong first unique window fails; second round with exclude verifies", () => {
    const round1 = iterateHostSeamShape({ source: DECOY });
    expect(round1.status).toBe("failed");
    expect(round1.round).toBe(1);
    const decoyCreate = structuralShapeSync(DECOY).candidates.filter((row) => row.sliceId === "create-session");
    expect(decoyCreate.length).toBeGreaterThan(1);
    const wrong = decoyCreate[0]!;
    const round2 = iterateHostSeamShape({
      source: DECOY,
      evidence: { excludeWindows: [{ startByte: wrong.startByte, endByte: wrong.endByte }] },
      prior: { sourceSha256: round1.sourceSha256, rounds: 1 },
    });
    expect(round2.status).toBe("verified_offline");
    expect(round2.round).toBe(2);
    expect(round2.candidates.filter((row) => row.sliceId === "create-session")).toHaveLength(1);
    expect(round2.writes).toBe(0);
  });

  test("third round hits budget; source change supersedes", () => {
    const sha = sha256Text(DECOY);
    const budget = iterateHostSeamShape({
      source: DECOY,
      sourceSha256: sha,
      prior: { sourceSha256: sha, rounds: 2 },
    });
    expect(budget.status).toBe("budget");
    expect(budget.unauthorizedCodeWrite).toBe(false);
    const changed = iterateHostSeamShape({
      source: LIVE_SHAPED_HOST,
      prior: { sourceSha256: sha, rounds: 1 },
    });
    expect(changed.status).toBe("superseded");
    expect(changed.limitations).toContain("source_changed");
  });
});
