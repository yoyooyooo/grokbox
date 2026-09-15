# Troubleshoot

Read `grokbox doctor` `next` and run that command.

| doctor host | Meaning | Next |
| --- | --- | --- |
| `official` | Custom-model channel off | `grokbox host start` |
| `custom` | Channel on | none for Host |
| `unknown` | Cannot prove Host; see `hostReason` | Retry on the computer, then doctor. `source_mismatch` → `grokbox runtime profile observe --from /home/box/sand-host/host-main.cjs then grokbox runtime profile write --sha <sourceSha256>`. `stale_attestation` / `unmanaged_preload` → `grokbox upgrade --yes` |

| doctor daemon | Meaning |
| --- | --- |
| `down` | `grokbox on` |
| `up` | Title sync can run |

Host switch kills Host. If bots are running, `host start` / `host stop` / `host restart` refuse and list them; use `--force` only when that interruption is accepted. `--force` does not bypass `source_mismatch`. The maintainer bot itself counts as running.

`confirmed_temporal` / `conflict`: leave that Bot; create a new one with grokbox. Official computer updates can drop the custom-model channel — `grokbox upgrade --yes` or `grokbox host start`.

`models use --for` failure: read `error.code` + `error.next`. Temporal → create a box Bot. Conflict/unconfirmed → `grokbox agents ownership <id>`. Host/bridge unread (`runtime_ownership_unavailable`) → `grokbox doctor then grokbox host start`. Never `host on --yes`.
