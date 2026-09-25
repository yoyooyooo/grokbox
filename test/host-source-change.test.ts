import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { build } from "esbuild";
import { createContext, runInContext } from "node:vm";
import { describeHostSourceChange, projectHostSourceChange, projectHostSourceWindow, type HostSourceWindow } from "../packages/runtime-kernel/src/host-source-change.ts";
import { canonicalJson, sha256Text } from "../packages/runtime-kernel/src/hash.ts";
import { captureHostSourceWindow, retainedHostSourceWindow, readHostSourceEvidencePins } from "../packages/box-runtime/src/internal/io/host-source-change.node.ts";
import { openMonitorStore } from "../packages/box-runtime/src/internal/io/monitor-store.node.ts";
import { openMonitorSqlite } from "../packages/box-runtime/src/internal/io/monitor-sqlite.node.ts";
import { readHostArtifacts } from "../packages/box-runtime/src/internal/io/host-artifact-source.node.ts";
import { readHostSourceEvidence, hostSourceEpisodeId, retainHostSourceEvidence, pruneHostSourceEvidence, hostSourceEvidenceBytes, HOST_SOURCE_EVIDENCE_MAX_BYTES } from "../packages/box-runtime/src/internal/io/provenance.node.ts";
import { profileFromSource, type SlicePatch } from "../packages/box-runtime/src/internal/host/profile.ts";
const install = "11111111-1111-4111-8111-111111111111", h = (s: string) => sha256Text(s);
function window(seed = "A", fields: Partial<HostSourceWindow> = {}): HostSourceWindow {
  const v = { version: 1 as const, sourceSet: "", sourceSha: h(seed), workerSha: h("worker"), profileDigest: null, recipeSha: h("recipe"),
    recipeState: "applicable" as const, coverage: "recipe-windows-and-worker" as const, slices: [{ id: "create-session", sha256: h("same-window") }], evidenceRef: h(`evidence-${seed}`), ...fields };
  v.sourceSet = h(canonicalJson([v.sourceSha, v.workerSha, v.profileDigest])); return v;
}
const change = (before: HostSourceWindow | null, after: HostSourceWindow | null, staticViolation = false, sequence = 1) =>
  describeHostSourceChange({ episodeId: hostSourceEpisodeId(install, sequence, before, after), before, after, staticViolation });

test("four-way relevance is bounded to measured recipe windows and the direct worker, never SHA equivalence", () => {
  const a = window();
  expect(change(a, window("B"))).toMatchObject({ classification: "no-intersection", userImpact: "not-established", running: null, executionAuthority: false });
  expect(change(a, window("B", { slices: [{ id: "create-session", sha256: h("changed body") }] }))).toMatchObject({ classification: "related-same-shape", changedSlices: ["create-session"] });
  expect(change(a, window("B", { workerSha: h("different-worker") })).classification).toBe("related-same-shape");
  expect(change(a, window("B", { recipeState: "mismatch" })).classification).toBe("structural-change");
  expect(change(a, window("B"), true)).toMatchObject({ classification: "structural-change", reason: "static-violation" });
  for (const c of [change(null, a), change(a, null), change(a, window("B", { evidenceRef: null })),
    change(a, window("B", { recipeSha: h("another-recipe") })), change(a, window("B", { slices: [{ id: "create-session", sha256: null }] }))]) expect(c.classification).toBe("unknown");
});
test("the shared Host event contract executes in a browser without Node globals and still verifies digest bindings", async () => {
  const bundle = await build({ entryPoints: [join(import.meta.dir, "../packages/runtime-kernel/src/host-health.ts")], bundle: true,
    platform: "browser", format: "iife", globalName: "HostHealth", write: false, logLevel: "silent" });
  const code = bundle.outputFiles[0]!.text;
  expect(code).not.toMatch(/node:|bun:/);
  const v = change(window(), window("B")), context = createContext({ TextEncoder, input: JSON.stringify(v) });
  runInContext(code, context);
  expect(runInContext("[typeof process, typeof require, typeof Buffer].join(',')", context)).toBe("undefined,undefined,undefined");
  expect(runInContext("HostHealth.projectHostSourceChange(JSON.parse(input)).classification", context)).toBe("no-intersection");
  expect(runInContext("(()=>{const v=JSON.parse(input);v.before.sourceSet='0'.repeat(64);return HostHealth.projectHostSourceChange(v);})()", context)).toBeNull();
});
test("A-B-A episodes and risk escalation are stable without claiming loaded success", () => {
  const a = window(), b = window("B", { workerSha: h("worker-B") });
  const first = change(a, b), again = change(a, b), back = change(b, a, false, 3), escalation = change(a, b, true);
  expect(first.episodeId).toBe(again.episodeId); expect(first.episodeId).not.toBe(back.episodeId);
  expect(escalation.episodeId).toBe(first.episodeId); expect(escalation.classification).not.toBe(first.classification);
  expect(projectHostSourceChange(first)).toEqual(first); expect(projectHostSourceChange(escalation, true)).toEqual(escalation);
  expect(projectHostSourceChange(escalation)).toBeNull();
  const running = { observationId: randomUUID(), sourceSha: a.sourceSha, candidateSha: h("old-running-candidate") };
  expect(describeHostSourceChange({ ...first, running }).running).toEqual(running);
});
test("public projection refuses forged classifications, extra private fields, accessors and claimed impact", () => {
  const v = change(window(), window("B"));
  for (const bad of [{ ...v, classification: "structural-change" }, { ...v, userImpact: "outage" }, { ...v, path: "/private/source" },
    { ...v, after: { ...v.after, snippet: "private-source" } }, { ...v, running: { observationId: randomUUID(), sourceSha: h("x"), candidateSha: null, pid: 1 } },
    { ...v, get reason() { throw Error("getter-must-not-run"); } }]) expect(projectHostSourceChange(bad)).toBeNull();
  expect(projectHostSourceWindow({ ...window(), evidenceRef: "latest" })).toBeNull();
  expect(projectHostSourceWindow({ ...window(), sourceSet: h("wrong-source-set") })).toBeNull();
});

const source = "function createSession(opts) { return opts; }\nfunction runTurn(host) { return host; }\n// END\n";
const slices: SlicePatch[] = [
  { id: "create-session", startAnchor: "function createSession", endAnchor: "function runTurn", find: "return opts;", replacement: "return opts;" },
  { id: "agent-id", startAnchor: "function runTurn", endAnchor: "// END", find: "return host;", replacement: "return host;" },
];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "host-source-window-owned-")); await mkdir(join(root, "inputs"), { mode: 0o700 });
  const paths = { source: join(root, "inputs/host.cjs"), worker: join(root, "inputs/worker.cjs"), profile: join(root, "inputs/profile.json") };
  await writeFile(paths.source, source, { mode: 0o600 }); await writeFile(paths.worker, "module.exports = {};\n", { mode: 0o600 });
  await writeFile(paths.profile, JSON.stringify(profileFromSource(source, slices)), { mode: 0o600 });
  return { root, paths, capture: async () => captureHostSourceWindow(root, await readHostArtifacts(paths), slices), close: () => rm(root, { recursive: true, force: true }) };
}
test("production stable reads preserve exact before/after private windows despite disk replacement", async () => {
  const f = await fixture(); try {
    const a = await f.capture(); expect(a.evidenceRef).not.toBeNull();
    await writeFile(f.paths.source, source + "// unrelated trailer\n"); const b = await f.capture();
    expect(change(a, b).classification).toBe("no-intersection");
    await writeFile(f.paths.source, source.replace("return opts;", "/* private-owned-change */ return opts;")); const c = await f.capture();
    expect(change(b, c).classification).toBe("related-same-shape");
    const before = await readHostSourceEvidence(f.root, b.evidenceRef!), after = await readHostSourceEvidence(f.root, c.evidenceRef!);
    expect(hostSourceEvidenceBytes(before!).toString("utf8")).toBe(source + "// unrelated trailer\n");
    expect(before!.windows[0]!.window!.text).not.toContain("private-owned-change"); expect(after!.windows[0]!.window!.text).toContain("private-owned-change");
    const publicEvent = JSON.stringify(change(b, c)); expect(publicEvent).not.toContain("private-owned-change"); expect(publicEvent).not.toContain(f.root);
    expect((await lstat(join(f.root, "host-bundles/source-evidence", `${a.evidenceRef}.json`))).mode & 0o777).toBe(0o600);
    await writeFile(f.paths.source, source.replace("function runTurn", "function changedTurn")); const d = await f.capture();
    expect(change(c, d).classification).toBe("structural-change");
  } finally { await f.close(); }
});
test("private retirement preserves original work pins and refuses deletion on an unknown pin read", async () => {
  const f = await fixture(); try {
    const a = await f.capture(); await writeFile(f.paths.source, source + "// orphaned owned generation\n"); const b = await f.capture();
    const rolled = { version: 1 as const, installationId: install, nextSequence: 0, acknowledgedThrough: -1, receipts: [] };
    expect(await pruneHostSourceEvidence(f.root, rolled, [], async () => null)).toBe(false);
    expect(await readHostSourceEvidence(f.root, b.evidenceRef!)).not.toBeNull();
    expect(await pruneHostSourceEvidence(f.root, rolled, [], async () => [a.evidenceRef!])).toBe(true);
    expect(await readHostSourceEvidence(f.root, a.evidenceRef!)).not.toBeNull();
    expect(await readHostSourceEvidence(f.root, b.evidenceRef!)).toBeNull();
  } finally { await f.close(); }
});
test("expired notification history cannot permanently saturate source pins, but an active evidence lease still protects missing evidence", async () => {
  const f = await fixture(); try {
    const store = openMonitorStore(f.root); await store.initialize();
    const db = await openMonitorSqlite(store.path, "write"), now = Date.now(), leasedIncident = randomUUID();
    try {
      await db.run("BEGIN IMMEDIATE");
      for (let n = 0; n < 200; n++) await db.run("INSERT INTO notification_work(id,incident_id,evidence_revision,state,created_at,expires_at) VALUES(?,?,1,'completed',?,?)",
        [randomUUID(), n === 0 ? leasedIncident : randomUUID(), now - 10000 - n, now - 1]);
      await db.run("COMMIT");
      expect(await store.notificationWork(200)).toHaveLength(200);
      expect(await readHostSourceEvidencePins(f.root)).toEqual([]);
      await db.run("INSERT INTO evidence_leases(id,incident_id,revision,created_at,expires_at,reserved_bytes) VALUES(?,?,1,?,?,1)",
        [randomUUID(), leasedIncident, now, now + 60000]);
      // A current lease with unavailable detail cannot authorize retirement,
      // even though its transport work has completed and expired.
      expect(await readHostSourceEvidencePins(f.root)).toBeNull();
    } finally { await db.close(); }
  } finally { await f.close(); }
});

test("missing, replaced, symlinked and oversize evidence remains unknown rather than resolving to live input", async () => {
  const f = await fixture(); try {
    const a = await f.capture(), path = join(f.root, "host-bundles/source-evidence", `${a.evidenceRef}.json`);
    const retained = (await readHostSourceEvidence(f.root, a.evidenceRef!))!;
    await expect(retainHostSourceEvidence(f.root, { ...retained, window: { ...retained.window, sourceSet: h("wrong-source-set") } })).rejects.toThrow("source-evidence-invalid");
    const bytes = await readFile(path); await writeFile(path, "{}");
    expect((await retainedHostSourceWindow(f.root, a)).evidenceRef).toBeNull(); await writeFile(path, bytes);
    await rm(path); await symlink(f.paths.source, path);
    expect((await retainedHostSourceWindow(f.root, a)).evidenceRef).toBeNull(); await rm(path);
    await writeFile(f.paths.worker, "//" + "x".repeat(HOST_SOURCE_EVIDENCE_MAX_BYTES)); const large = await f.capture();
    expect(large.evidenceRef).toBeNull(); expect(change(a, large).classification).toBe("unknown");
    expect(await readHostSourceEvidence(f.root, a.evidenceRef!)).toBeNull();
  } finally { await f.close(); }
});
