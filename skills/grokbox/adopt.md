# Adopt — Host recovery

Advanced playbook for doctor-directed recovery: `grokbox skills get grokbox --topic adopt`. Load when an official computer update, package alignment, or model-use error explicitly points to Host recovery. A healthy official-only setup does not need this procedure.

The operator/template Bot stays on the official brain. Run exact `doctor` / `error.next` commands within the authorized recovery scope; explain the affected capability and outcome plainly. Do not expose credentials or raw runtime material.

## Decision tree

| Situation | Action |
| --- | --- |
| Need status | `grokbox doctor`; read the checks and `next`. |
| Services are down | Follow the scoped `grokbox on` suggestion; service effects are in [services](services.md). |
| Installed grokbox package needs alignment | Follow `grokbox upgrade --yes` only for the authorized update. |
| Custom channel is off and requested | `grokbox host start`. |
| Next is observe → write | Follow printed `next` literally. A known live digest is supplied as `write --sha` with full hex; otherwise observe first. Never invent a SHA placeholder. |
| Write rejects on drift | Follow **write's** `error.next`; `error.profileWrite` preserves the refusal and failing slice/code. A recipe mismatch needs adaptation, not the same write again. |
| Only ownership-local capability is outdated | Use the printed `profile analyze --capability ownership-local` next; the bounded upgrade path below preserves unrelated reviewed slices. |
| Write succeeds | The durable file changed, not the loaded Host. Run doctor; `host start` can be a no-op on an already-custom Host. Follow the scoped loaded-profile/restart next. |
| Re-adopt says operation-busy | Inspect `grokbox runtime operation-recovery --json`; do not delete lock files. Explicit stale-metadata recovery is described below. |
| Host switch refuses because Bots are running | Obtain acceptance of that interruption before using the corresponding `--force`. The operator Bot counts. |
| Force cannot bypass source/profile mismatch | Stop forcing; return to doctor / write next. |
| No safe next, or repeated failure | Use the failsafe below; stop the recovery loop. |

## Recoverable Host update

1. Run `grokbox doctor` and retain its exact `next`.
2. If next is observe → write, run observe and then write with the retained digest or exact next string.
3. On write reject-on-drift, follow write's next. Analyze may settle `missing_runner` while emitting `envelope.requiredIds`. A `recipe_unapplicable` / `recipeFailure` needs adaptation; an executable write next exists only when its recipe is applicable. Do not skip a required `--slice-review`.
4. Once the profile is durable, run doctor. Follow its loaded-state next under the existing interruption authorization; starting an already-custom Host does not reload its profile.
5. Re-run doctor. Inspect Host origin, modeld service admission, `hostCapabilities` and `committed` separately. A ready loaded bridge does not clear a pending or unavailable commit observation. Lifecycle `alignment=verified` is component evidence, not a Bot execution permit or Provider roundtrip. Finish when the requested scope's blockers are gone; unrelated next items do not widen permission.

## Bounded ownership-local upgrade

Only the maintained `ownership-local` selector is supported. Analyze the retained same-source generation using `--capability ownership-local`, then review its `capabilityUpgrade` and exact next. Write requires `--expected-reviewed-sha` from that analysis; this is the reviewed file's digest, not the Host source SHA. An intervening baseline change requires new analysis.

This path replaces the ownership schema/API/resume dependency set, preserves unrelated reviewed slices, and still requires the original envelope golden/review and atomic publisher. Missing golden, unprovable baseline or target slice mismatch stays blocked. Do not invent a skip list or manually edit `reviewed.json`. Publication does not authorize adoption, restart or a new model request.

## Interrupted controller / identity operation

`grokbox runtime operation-recovery --json` only observes local owner records and the operation store. With explicit metadata-recovery authorization, `grokbox runtime operation-recovery --confirm --json` can clear only proven stale controller/identity records under their Linux kernel gates, marking interrupted `running` entries `unknown`.

Cancellation before recovery starts leaves records untouched. Cancellation after metadata commit starts waits for that protected commit boundary; a missing completion receipt is not rollback proof. Inspect again before another recovery or adoption.

Recovery does not signal a Host, fabricate attestation, clear the adopt journal, or replay business work. Only the current complete owner identity is eligible: PID-only records remain blocked even after that PID exits, and a running operation without its own identity cannot borrow a stale lock's evidence. Live/unproven owners and malformed records remain blocked. Writers require `/usr/bin/flock`; the PID-only writer and recovery fallback have been removed. Stop old-version maintenance writers before recovery; uncooperative/manual file replacement is not covered by the new gates. A recovered receipt is not successful re-adoption. The same unknown controller operation stays uncertain even when the current official process chain is unique. Inspect `runtime status --json` and preserve its original operation ID and prefix; do not repeatedly re-adopt, clear the row, or invent a new ID to escape the unknown result.

## Unrecoverable failsafe

Attempt the authorized `grokbox host stop` to restore the official Host. It can still refuse because Bots are running; do not silently escalate to `--force`.

After a successful stop, run doctor and verify Host `official` before saying “The computer is back on the official channel; custom-model recovery needs a maintainer.” A stop command being attempted is not rollback proof.

If stop fails, is blocked, or doctor cannot confirm the state, say that recovery/rollback is blocked or unverified, report the relevant cause, and stop. Do not claim the official channel is restored. Request interruption approval only when that is the specific missing authorization.

Do not thrash `--force`, invent alternative injection paths, change the operator's model, or replay business work. Hand off the redacted error and exact safe next, if one exists. Ownership and model selection remain separate capabilities: [ownership](ownership.md), [models](models.md).
