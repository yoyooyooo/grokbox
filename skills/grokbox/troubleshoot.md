# Troubleshoot

Read `grokbox doctor` `next` and run that command. Speak **two voices**: people hear friendly outcomes; you keep exact CLI / `error.next` to yourself. Deep Host recover: [adopt.md](adopt.md).

| doctor host | Meaning (you) | Person hears | You run |
| --- | --- | --- | --- |
| `official` | Custom-model channel off | “Opening the custom-model channel…” | `grokbox host start` |
| `custom` | Channel on | “Custom channel looks good.” | none for Host |
| `unknown` | Cannot prove Host; see `hostReason` | “Checking / aligning this computer…” | Retry on the computer, then doctor. Follow printed `next`. Typical: observe → write path, or `grokbox upgrade --yes` for stale / unmanaged cases. Details: [adopt.md](adopt.md) |

| doctor daemon | Meaning (you) | Person hears | You run |
| --- | --- | --- | --- |
| `down` | Services off | “Turning grokbox services on…” | `grokbox on` |
| `up` | Title sync can run | — | none for daemon |

## Host switch

Host switch kills Host. If bots are running, `host start` / `host stop` / `host restart` refuse and list them; use `--force` only when that interruption is accepted. `--force` does not bypass a live-Host vs reviewed-profile mismatch — follow doctor / write `next` first (see [adopt.md](adopt.md)). The operator bot itself counts as running.

## Unrecoverable

If recover next is exhausted or keep failing: `grokbox host stop` (back on official channel). Tell the person you’re on the official channel and waiting for a maintainer. Do **not** thrash `--force`. Full tree: [adopt.md](adopt.md).

## Ownership / models

`confirmed_temporal` / `conflict`: leave that Bot; create a new one with grokbox. Official computer updates can drop the custom-model channel — follow doctor next (`upgrade`, observe→write, or `host start`).

`models use --for` failure: read `error.code` + `error.next`. Temporal → create a box Bot. Conflict/unconfirmed → `grokbox agents ownership <id>`. Host/bridge unread (`runtime_ownership_unavailable`) → `grokbox doctor` then follow next (often `host start` or adopt path). Never `host on --yes`.

**Operator Bot:** stay on official brain — do not `models use` yourself. Custom-model experiments only on disposable Bots. See [models.md](models.md).
