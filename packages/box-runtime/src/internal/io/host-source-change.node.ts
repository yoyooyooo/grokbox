import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { projectHostHealth, type HostSourceWindow } from "@grokbox/runtime-kernel/host-health";
import { gzipSync } from "node:zlib";
import { openMonitorStore } from "./monitor-store.node.ts";
import type { HostArtifacts } from "./host-artifact-source.node.ts";
import { retainHostSourceEvidence, readHostSourceEvidence } from "./provenance.node.ts";
import { preflightProfileRecipe, type SlicePatch } from "../host/profile.ts";
import { measureRecipeWindow } from "../ops/host-seam/envelope-windows.ts";

/** Capture from the SAME stable source set as analysis. No new read/watch owner,
 * recipe publication or full-Host semantic claim. The whole worker is a known
 * direct dependency; arbitrary Host bytes outside these windows are uncovered. */
export async function captureHostSourceWindow(root: string, artifacts: HostArtifacts, fallbackRecipe: readonly SlicePatch[]): Promise<HostSourceWindow> {
  const slices = artifacts.profile?.slices ?? fallbackRecipe;
  const source = new TextDecoder("utf-8", { fatal: true }).decode(artifacts.source);
  const worker = new TextDecoder("utf-8", { fatal: true }).decode(artifacts.worker);
  const recipe = preflightProfileRecipe(source, slices, "source-observation");
  const measured = slices.map(slice => {
    try {
      const window = measureRecipeWindow(source, slice);
      if (window.count.start !== 1 || window.count.end !== 1) return { id: slice.id, sha256: null, window: null };
      return { id: slice.id, sha256: window.windowSha,
        window: { ...window.byteRange, text: Buffer.from(artifacts.source).subarray(window.byteRange.startByte, window.byteRange.endByte).toString("utf8") } };
    } catch { return { id: slice.id, sha256: null, window: null }; }
  });
  const value: HostSourceWindow = { version: 1, sourceSet: artifacts.sourceSet, sourceSha: artifacts.sourceSha, workerSha: artifacts.workerSha,
    profileDigest: artifacts.profileDigest, recipeSha: sha256Text(canonicalJson(slices)), recipeState: recipe.ok ? "applicable" : "mismatch",
    coverage: "recipe-windows-and-worker", slices: measured.map(({ id, sha256 }) => ({ id, sha256 })), evidenceRef: null };
  // Private material is bounded by the provenance owner. Failure is represented
  // by evidenceRef=null and therefore unknown, not silently replaced by live bytes.
  try { value.evidenceRef = await retainHostSourceEvidence(root, { version: 1, window: value, recipe: slices, windows: measured, sourceGzip: gzipSync(artifacts.source, { level: 1 }).toString("base64"), worker }); }
  catch { /* finite evidence-unavailable classification, never execution success */ }
  return value;
}
/** Read existing OBS work and immutable revisions, without another event/pin
 * database. Lack of a complete read is conservative storage pressure, not GC. */
export async function readHostSourceEvidencePins(root: string): Promise<string[] | null> {
  try {
    const store = openMonitorStore(root), work = await store.notificationWork(200);
    if (work.length >= 200) return null;
    const pins = new Set<string>();
    for (const row of work) {
      const evidence = await store.incidentEvidence(String(row.incidentId), Number(row.evidenceRevision));
      if (evidence.state !== "available" && !["completed", "expired", "superseded"].includes(String(row.state))) return null;
      for (const fact of evidence.facts) {
        const change = "value" in fact ? projectHostHealth(fact.value)?.sourceChange : undefined;
        for (const ref of [change?.before?.evidenceRef, change?.after?.evidenceRef]) if (ref) pins.add(ref);
      }
    }
    return [...pins];
  } catch { return null; }
}
export async function retainedHostSourceWindow(root: string, value: HostSourceWindow): Promise<HostSourceWindow> {
  if (!value.evidenceRef) return value;
  try {
    const retained = await readHostSourceEvidence(root, value.evidenceRef);
    if (retained && canonicalJson(retained.window) === canonicalJson({ ...value, evidenceRef: null })) return value;
  } catch { /* damaged/missing evidence is unknown; do not recapture from latest */ }
  return { ...value, evidenceRef: null };
}
