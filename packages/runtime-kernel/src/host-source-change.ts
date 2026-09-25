import { canonicalJson, sha256Text } from "./portable-hash.ts";

/** A finite relevance claim, not a JavaScript equivalence or adoption proof. */
export type HostSourceWindow = {
  version: 1;
  sourceSet: string;
  sourceSha: string;
  workerSha: string;
  profileDigest: string | null;
  recipeSha: string;
  recipeState: "applicable" | "mismatch" | "unknown";
  coverage: "recipe-windows-and-worker";
  slices: { id: string; sha256: string | null }[];
  evidenceRef: string | null;
};
export type HostSourceChangeClassification = "no-intersection" | "related-same-shape" | "structural-change" | "unknown";
export type HostSourceChange = {
  version: 1;
  episodeId: string;
  classification: HostSourceChangeClassification;
  reason: "source-unavailable" | "baseline-unavailable" | "evidence-unavailable" | "coverage-changed" | "coverage-incomplete"
    | "recipe-structure-changed" | "static-violation" | "covered-inputs-unchanged" | "covered-inputs-changed";
  before: HostSourceWindow | null;
  after: HostSourceWindow | null;
  changedSlices: string[];
  running: { observationId: string; sourceSha: string; candidateSha: string | null } | null;
  userImpact: "not-established";
  executionAuthority: false;
};
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const uuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const token = (v: unknown): v is string => typeof v === "string" && /^[a-z][a-z0-9.-]{0,79}$/.test(v);
function exact(v: unknown, keys: string[]): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v) && Reflect.ownKeys(v).length === keys.length
    && keys.every(k => Object.hasOwn(v, k) && "value" in Object.getOwnPropertyDescriptor(v, k)!);
}
export function projectHostSourceWindow(raw: unknown): HostSourceWindow | null {
  if (!exact(raw, ["version", "sourceSet", "sourceSha", "workerSha", "profileDigest", "recipeSha", "recipeState", "coverage", "slices", "evidenceRef"])) return null;
  const v = raw as unknown as HostSourceWindow;
  if (v.version !== 1 || ![v.sourceSet, v.sourceSha, v.workerSha, v.recipeSha].every(hash)
    || v.profileDigest !== null && !hash(v.profileDigest) || v.evidenceRef !== null && !hash(v.evidenceRef)
    || v.sourceSet !== sha256Text(canonicalJson([v.sourceSha, v.workerSha, v.profileDigest]))
    || !["applicable", "mismatch", "unknown"].includes(v.recipeState) || v.coverage !== "recipe-windows-and-worker"
    || !Array.isArray(v.slices) || v.slices.length < 1 || v.slices.length > 128
    || v.slices.some(s => !exact(s, ["id", "sha256"]) || !token(s.id) || s.sha256 !== null && !hash(s.sha256))
    || new Set(v.slices.map(s => s.id)).size !== v.slices.length) return null;
  return { ...v, slices: v.slices.map(s => ({ ...s })) };
}
export function describeHostSourceChange(input: {
  episodeId: string; before: HostSourceWindow | null; after: HostSourceWindow | null;
  staticViolation?: boolean; running?: HostSourceChange["running"];
}): HostSourceChange {
  const before = input.before === null ? null : projectHostSourceWindow(input.before);
  const after = input.after === null ? null : projectHostSourceWindow(input.after);
  if (!hash(input.episodeId) || input.before !== null && !before || input.after !== null && !after) throw Error("invalid-source-change");
  const running = input.running ?? null;
  if (running !== null && (!exact(running, ["observationId", "sourceSha", "candidateSha"]) || !uuid(running.observationId)
    || !hash(running.sourceSha) || running.candidateSha !== null && !hash(running.candidateSha))) throw Error("invalid-source-running-evidence");
  const prior = new Map(before?.slices.map(s => [s.id, s.sha256]) ?? []);
  const next = new Map(after?.slices.map(s => [s.id, s.sha256]) ?? []);
  const changedSlices = [...new Set([...prior.keys(), ...next.keys()])].filter(id => prior.get(id) !== next.get(id)).sort();
  let classification: HostSourceChangeClassification = "unknown", reason: HostSourceChange["reason"];
  if (!after) reason = "source-unavailable";
  else if (!after.evidenceRef || before !== null && !before.evidenceRef) reason = "evidence-unavailable";
  else if (after.recipeState === "mismatch") { classification = "structural-change"; reason = "recipe-structure-changed"; }
  else if (input.staticViolation) { classification = "structural-change"; reason = "static-violation"; }
  else if (!before) reason = "baseline-unavailable";
  else if (before.recipeSha !== after.recipeSha || canonicalJson(before.slices.map(s => s.id)) !== canonicalJson(after.slices.map(s => s.id))) reason = "coverage-changed";
  else if (before.recipeState !== "applicable" || after.recipeState !== "applicable" || [...before.slices, ...after.slices].some(s => s.sha256 === null)) reason = "coverage-incomplete";
  else if (changedSlices.length || before.workerSha !== after.workerSha) { classification = "related-same-shape"; reason = "covered-inputs-changed"; }
  else { classification = "no-intersection"; reason = "covered-inputs-unchanged"; }
  return { version: 1, episodeId: input.episodeId, classification, reason, before, after, changedSlices,
    running: running ? { ...running } : null, userImpact: "not-established", executionAuthority: false };
}
/** Strict public projection: no paths/snippets, no inferred running/adoption or
 * altered classification. The enclosing evidence supplies the static verdict. */
export function projectHostSourceChange(raw: unknown, staticViolation = false): HostSourceChange | null {
  try {
    if (!exact(raw, ["version", "episodeId", "classification", "reason", "before", "after", "changedSlices", "running", "userImpact", "executionAuthority"])) return null;
    const v = raw as unknown as HostSourceChange;
    const result = describeHostSourceChange({ episodeId: v.episodeId, before: v.before, after: v.after, staticViolation, running: v.running });
    return canonicalJson(v) === canonicalJson(result) ? result : null;
  } catch { return null; }
}
