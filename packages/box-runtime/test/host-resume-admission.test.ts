import { test, expect } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Script } from "node:vm";
import { deferManagedHostResume } from "../src/internal/host/selection.node.ts";
import { OWNERSHIP_READ_SLICES } from "../src/internal/host/ownership-slices.ts";
import { HOST_RESUME_GATE_SYMBOL, transformUnchecked } from "../src/internal/host/profile.ts";
import { OWNERSHIP_SHAPED_HOST } from "./ownership-shaped-host.ts";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

test("paused managed resume keeps the native marker and starts no runner; native release resumes once", async () => {
  const root = await mkdtemp(join(tmpdir(), "gbox-resume-admission-"));
  try {
    await writeFile(join(root, "models.json"), JSON.stringify({ version: 1, models: {}, assignments: { main: null, agents: { [A]: "stub/echo" } } }));
    const patch = OWNERSHIP_READ_SLICES.filter(s => s.id === "ownership-resume-gate");
    const applied = transformUnchecked(OWNERSHIP_SHAPED_HOST, patch);
    expect(applied.ok).toBe(true);
    if (!applied.ok) throw Error("fixture mismatch");
    const source = applied.source.slice(applied.source.indexOf("const resumeFixture ="));
    const global = { [Symbol.for(HOST_RESUME_GATE_SYMBOL)]: (id: unknown, allowed: unknown) => deferManagedHostResume(root, id, allowed) };
    const native = new Script(source + "\nresumeFixture").runInNewContext({ globalThis: global, Symbol });
    const marker = { agentId: A, markedAtMs: 42 };
    let writes = 0, clears = 0, runs = 0;
    native.tm = { execution: { isLocalWorkAllowed: false }, upgradeResumeStore: { markPending: () => { writes++; }, clear: () => { clears++; } } };
    native.pauseResumeInFlightAgentIds = new Set();
    native.resumeUpgradeAgent = () => { runs++; return "resumed"; };
    expect(native.startUpgradeResume(marker)).toBe("skipped");
    expect({ writes, clears, runs }).toEqual({ writes: 0, clears: 0, runs: 0 });
    expect(native.pauseResumeInFlightAgentIds.size).toBe(0);
    expect(native.tm.execution.isLocalWorkAllowed).toBe(false);
    native.tm.execution.isLocalWorkAllowed = true; // only the native owner releases its hold
    expect(native.startUpgradeResume(marker)).toBe("resumed");
    expect({ writes, clears, runs }).toEqual({ writes: 1, clears: 0, runs: 1 });
    expect(deferManagedHostResume(root, B, false)).toBe(false); // official native behavior unchanged
    await writeFile(join(root, "models.json"), "bad-json");
    expect(deferManagedHostResume(root, A, false)).toBe(true);
    expect(deferManagedHostResume(root, A, undefined)).toBe(true);
    expect(deferManagedHostResume(root, A, true)).toBe(false); // normal session's strict config gate still owns rejection
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("missing resume hook while paused cannot consume a marker", () => {
  const applied = transformUnchecked(OWNERSHIP_SHAPED_HOST, OWNERSHIP_READ_SLICES.filter(s => s.id === "ownership-resume-gate"));
  if (!applied.ok) throw Error("fixture mismatch");
  const native = new Script(applied.source.slice(applied.source.indexOf("const resumeFixture =")) + "\nresumeFixture").runInNewContext({ globalThis: {}, Symbol });
  native.tm = { execution: { isLocalWorkAllowed: false }, upgradeResumeStore: { markPending: () => { throw Error("marker_write"); } } };
  expect(native.startUpgradeResume({ agentId: A })).toBe("skipped");
});
