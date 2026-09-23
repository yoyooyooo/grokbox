/** Development observation only. Source identity and recipe applicability are
 * separate facts; neither grants ABI qualification, loaded health or adoption.
 * Earlier evidence keeps its exact artifact scope when a new source arrives. */
export type NativeSourceIdentity = Readonly<{ host: string; worker: string }>;
export function describeHostSourceEvolution(reference: NativeSourceIdentity, observed: NativeSourceIdentity,
  recipeState: "applicable-not-reviewed" | "mismatch") {
  const hash = /^[a-f0-9]{64}$/;
  for (const identity of [reference, observed]) {
    if (!hash.test(identity.host) || !hash.test(identity.worker)) throw Error("invalid_native_source_identity");
  }
  if (recipeState !== "applicable-not-reviewed" && recipeState !== "mismatch") throw Error("invalid_recipe_state");
  const changedComponents = (["host", "worker"] as const).filter(key => reference[key] !== observed[key]);
  return {
    version: 1 as const, reference: { host: reference.host, worker: reference.worker },
    observed: { host: observed.host, worker: observed.worker }, changedComponents,
    identityState: changedComponents.length ? "changed" as const : "unchanged" as const, recipeState,
    interpretation: recipeState === "mismatch" ? "recipe-regression" as const
      : changedComponents.length ? "source-change-needs-abi-proof" as const : "same-source-not-full-health" as const,
    historicalEvidence: "retained-for-exact-source" as const,
    loadedState: "not-observed" as const, adoptionAuthorized: false as const,
  };
}
