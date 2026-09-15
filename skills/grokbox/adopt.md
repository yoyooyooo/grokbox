# Adopt — Agent Host recover playbook

Primary operators are Agents. Use **two voices**: people hear friendly outcomes; you run exact CLI / `doctor` / `error.next`. Never say SHA, reviewed, preload, envelope, or source_mismatch to people.

Load this skill first if you have not: `grokbox skills get grokbox` (or `--full`).

## When to use

Official computer updates, package upgrades, or doctor saying the custom-model channel is off / unknown. Also when `models use --for` (on a **disposable** Bot) points at Host recovery via `error.next`.

**Operator Bot stays on the official brain.** Do not `models use` yourself. Create temp Bots for model tests.

## Decision tree

| Situation | Person hears | You run |
| --- | --- | --- |
| Need status | “Checking this computer…” | `grokbox doctor` — then run printed `next` if not `none` |
| Daemon / services down | “Turning grokbox services on…” | `grokbox on` (often doctor next) |
| After grokbox package update | “Aligning this computer with the new grokbox…” | `grokbox upgrade --yes` when doctor next says so (e.g. stale / unmanaged cases) |
| Custom channel off (`host` official) | “Opening the custom-model channel…” | `grokbox host start` |
| Doctor / error next is observe → write | “Updating this computer for the new system build…” (no jargon) | Follow `next` literally: `grokbox runtime profile observe --from /home/box/sand-host/host-main.cjs` then `grokbox runtime profile write --sha <sourceSha256>` from observe output |
| Write succeeds | “Almost done — switching the channel on…” | `grokbox host start` |
| Write rejects on drift | “Still aligning with the new build…” | Follow **write’s** `error.next` exactly (often analyze then `write --sha … --slice-review …`). Do not invent flags. |
| `host start` / `stop` refuse (bots running) | Ask if a short pause is OK; only then proceed | `grokbox host start --force` **only** if refuse + pause accepted. Operator Bot counts as running. |
| `--force` still cannot bypass mismatch | “Need one more alignment step first…” | Do **not** thrash `--force`. Re-read doctor / write `next` and continue the recover path. |
| **Unrecoverable** (next exhausted, repeated refuse, unknown with no safe next) | “I’m back on the official channel and waiting for a maintainer. I won’t keep forcing switches.” | `grokbox host stop` (cancel patch channel). Stop looping. Wait for maintainer. |

## Recoverable Host update (happy path)

1. `grokbox doctor` → read `next`.
2. If next is observe → write: run observe, then write with the retained digest from observe (or the exact next string).
3. If write reject-on-drift: run the **write** response’s `next` (commonly includes `--slice-review`); do not skip review.
4. When write is durable: `grokbox host start`.
5. Re-run `grokbox doctor`; done when next is `none` (or only unrelated work remains).

## Unrecoverable failsafe

- Prefer `grokbox host stop` so the computer is on the **official** Host.
- Tell the person you are on the official channel and waiting for a maintainer.
- Do **not** thrash `--force`, do not invent alternate inject paths, do not `models use` the operator Bot as a workaround.

## Related

- Short table: [troubleshoot.md](troubleshoot.md)
- Ownership / who may get models: [ownership.md](ownership.md), [models.md](models.md)
