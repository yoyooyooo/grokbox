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
| Write rejects on drift | Follow **write's** `error.next`, commonly analyze then `write --sha … --slice-review …`. Use the emitted arguments, not a remembered recipe. |
| Write succeeds | `grokbox host start`, then doctor to verify the requested channel. |
| Host switch refuses because Bots are running | Obtain acceptance of that interruption before using the corresponding `--force`. The operator Bot counts. |
| Force cannot bypass source/profile mismatch | Stop forcing; return to doctor / write next. |
| No safe next, or repeated failure | Use the failsafe below; stop the recovery loop. |

## Recoverable Host update

1. Run `grokbox doctor` and retain its exact `next`.
2. If next is observe → write, run observe and then write with the retained digest or exact next string.
3. On write reject-on-drift, follow write's next. Analyze may settle `missing_runner` while still emitting `envelope.requiredIds` and the write next. Do not treat that artifact as empty or skip a required `--slice-review`.
4. Once the profile write is durable, run `grokbox host start`. A profile write alone is not a live Host transition.
5. Re-run doctor. Finish when the requested channel is confirmed and relevant blockers are gone; unrelated next items are not permission to expand the task.

## Unrecoverable failsafe

Attempt the authorized `grokbox host stop` to restore the official Host. It can still refuse because Bots are running; do not silently escalate to `--force`.

After a successful stop, run doctor and verify Host `official` before saying “The computer is back on the official channel; custom-model recovery needs a maintainer.” A stop command being attempted is not rollback proof.

If stop fails, is blocked, or doctor cannot confirm the state, say that recovery/rollback is blocked or unverified, report the relevant cause, and stop. Do not claim the official channel is restored. Request interruption approval only when that is the specific missing authorization.

Do not thrash `--force`, invent alternative injection paths, change the operator's model, or replay business work. Hand off the redacted error and exact safe next, if one exists. Ownership and model selection remain separate capabilities: [ownership](ownership.md), [models](models.md).
