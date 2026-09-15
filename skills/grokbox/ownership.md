# Ownership

Server registration is the execution fact. Local `harness=` on `agents list` is a declaration.

| Class | Meaning | grokbox brain |
| --- | --- | --- |
| `confirmed_box` | Server and local agree **box** | Eligible for `models use` |
| `confirmed_temporal` | Server **temporal** (Cursor Server Agent Loop) | Leave it. Host patch never sees App turns |
| `conflict` | Server and local disagree | Stop. Do not send, use, or retitle as box |
| `unconfirmed` | Read failed or identity unstable | Retry ownership; do not guess box |

`models use --for` refuses before writing when the Bot is not `confirmed_box`. Errors are not a bare machine reason:

| `error.code` | Cause | `next` |
| --- | --- | --- |
| `runtime_ownership_temporal` | Server/local agree temporal | `grokbox agents create --harness box` |
| `runtime_ownership_conflict` | Server/local disagree | `grokbox agents ownership <id>` |
| `runtime_ownership_unconfirmed` | Identity missing or stale | `grokbox agents ownership <id>` |
| `runtime_ownership_unavailable` | Host/bridge/server read down | `grokbox doctor then grokbox host start` |

Do not run deleted `host on --yes`. Host channel is `grokbox host start`. A failed use does not mutate `models.json`.

If `blockers` include `host_channel_not_enabled`, `next` is `grokbox host start`. If they include `host_source_mismatch`, `next` is `grokbox runtime profile observe --from /home/box/sand-host/host-main.cjs then grokbox runtime profile write --sha <sourceSha256>`. Those are Host-channel gaps, not identity loss.

`confirmed_box` is not a production sign-off.

Create with `grokbox agents create --harness box` (default box). Then `agents ownership` until `confirmed_box`. Unknown create must not be retried as a second Bot.

If ownership later becomes temporal or conflict: drop managed use for that id. A showing title trailer refreshes to `owner=temporal` or `owner=conflict` and drops `m=`. Official Host upgrade migration stays the Server's.
