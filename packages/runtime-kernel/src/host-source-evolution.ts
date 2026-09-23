/** Development observations, never loading/adoption authority. Source identity,
 * complete recipe, static semantics, native ABI and declared coverage are five
 * independent facts. Unperformed checks remain unknown, not successful. */
export type NativeSourceIdentity = Readonly<{ host: string; worker: string }>;
export type EvolutionCheck = { id: string; revision: number; code: string };
export type EvolutionChecks = { state: "not-run" | "passed" | "failed" | "incomplete"; failed: EvolutionCheck[]; unsupported: EvolutionCheck[] };
export type EvolutionFacts = {
  recipeFailure?: { code: string; sliceId: string | null } | null;
  semantics?: EvolutionChecks;
  nativeAbi?: EvolutionChecks;
  uncoveredSlices?: string[] | null;
};
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const token = (value: unknown): value is string => typeof value === "string" && /^[a-z][a-z0-9.-]{0,79}$/.test(value);
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
  && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key) && "value" in Object.getOwnPropertyDescriptor(value, key)!);
function checks(value?: EvolutionChecks): EvolutionChecks {
  if (value === undefined) return { state: "not-run", failed: [], unsupported: [] };
  if (!exact(value, ["state", "failed", "unsupported"]) || !["not-run", "passed", "failed", "incomplete"].includes(value.state)) throw Error("invalid_evolution_checks");
  for (const rows of [value.failed, value.unsupported]) {
    if (!Array.isArray(rows) || rows.length > 64 || rows.some(row => !exact(row, ["id", "revision", "code"]) || !token(row.id) || !token(row.code)
      || !Number.isSafeInteger(row.revision) || row.revision < 1 || row.revision > 10000)) throw Error("invalid_evolution_checks");
  }
  const rows = [...value.failed, ...value.unsupported];
  if (new Set(rows.map(row => row.id)).size !== rows.length || value.state === "failed" && !value.failed.length
    || value.state === "incomplete" && (!value.unsupported.length || value.failed.length)
    || ["passed", "not-run"].includes(value.state) && rows.length) throw Error("invalid_evolution_checks");
  return { state: value.state, failed: value.failed.map(({ id, revision, code }) => ({ id, revision, code })),
    unsupported: value.unsupported.map(({ id, revision, code }) => ({ id, revision, code })) };
}
export function describeHostSourceEvolution(reference: NativeSourceIdentity, observed: NativeSourceIdentity,
  recipeState: "applicable-not-reviewed" | "mismatch", facts: EvolutionFacts = {}) {
  for (const identity of [reference, observed]) if (!identity || !hash(identity.host) || !hash(identity.worker)) throw Error("invalid_native_source_identity");
  if (!["applicable-not-reviewed", "mismatch"].includes(recipeState)) throw Error("invalid_recipe_state");
  const recipeFailure = facts.recipeFailure ?? null;
  if (recipeFailure !== null && (!exact(recipeFailure, ["code", "sliceId"]) || !token(recipeFailure.code)
    || recipeFailure.sliceId !== null && !token(recipeFailure.sliceId) || recipeState !== "mismatch")) throw Error("invalid_recipe_failure");
  const uncovered = facts.uncoveredSlices ?? null;
  if (uncovered !== null && (!Array.isArray(uncovered) || uncovered.length > 128 || !uncovered.every(token) || new Set(uncovered).size !== uncovered.length)) throw Error("invalid_evolution_coverage");
  const changedComponents = (["host", "worker"] as const).filter(key => reference[key] !== observed[key]);
  const semantics = checks(facts.semantics), nativeAbi = checks(facts.nativeAbi);
  return {
    version: 2 as const, reference: { host: reference.host, worker: reference.worker }, observed: { host: observed.host, worker: observed.worker }, changedComponents,
    identityState: changedComponents.length ? "changed" as const : "unchanged" as const, recipeState,
    recipeFailure: recipeFailure ? { code: recipeFailure.code, sliceId: recipeFailure.sliceId } : null,
    semantics, nativeAbi,
    coverage: { state: uncovered === null ? "not-evaluated" as const : uncovered.length ? "incomplete" as const : "covered-for-declared-slices" as const,
      uncoveredSlices: uncovered === null ? null : [...uncovered] },
    interpretation: recipeState === "mismatch" ? "recipe-regression" as const
      : changedComponents.length ? "source-change-needs-abi-proof" as const : "same-source-not-full-health" as const,
    historicalEvidence: "retained-for-exact-source" as const, loadedState: "not-observed" as const, adoptionAuthorized: false as const,
  };
}
export type HostSourceEvolution = ReturnType<typeof describeHostSourceEvolution>;
/** Rebuild the finite public shape; reject additions instead of storing private
 * paths, source snippets or caller claims of loading/adoption. */
export function projectHostSourceEvolution(value: unknown): HostSourceEvolution | null {
  try {
    const v = value as HostSourceEvolution;
    if (!exact(v, ["version", "reference", "observed", "changedComponents", "identityState", "recipeState", "recipeFailure", "semantics", "nativeAbi", "coverage", "interpretation", "historicalEvidence", "loadedState", "adoptionAuthorized"])
      || !exact(v.reference, ["host", "worker"]) || !exact(v.observed, ["host", "worker"]) || !exact(v.coverage, ["state", "uncoveredSlices"])) return null;
    const projected = describeHostSourceEvolution(v.reference, v.observed, v.recipeState,
      { recipeFailure: v.recipeFailure, semantics: v.semantics, nativeAbi: v.nativeAbi, uncoveredSlices: v.coverage.uncoveredSlices });
    // Compare values independently of JSON property ordering.
    const canonical = (input: unknown): string => JSON.stringify(input, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
    return canonical(projected) === canonical(v) ? projected : null;
  } catch { return null; }
}
