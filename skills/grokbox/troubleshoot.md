# Troubleshoot

Load after a command failure or an unhealthy doctor check: `grokbox skills get grokbox --topic troubleshoot`. Diagnose first; a suggested repair is not permission for unrelated changes.

```bash
grokbox doctor
```

Read the failing check, `error.code`, and `next`. Keep exact commands for execution; tell people what is affected and what remains uncertain. No need to enumerate every internal diagnostic field unless asked.

## Route to the smallest relevant capability

| Observation | Meaning / safe next step | Read only if needed |
| --- | --- | --- |
| Host `official` | Custom channel is off; normal for official-only work. Enable it only for a requested custom-model task. | [services](services.md) |
| Host `custom` | Origin is present; inspect `hostCapabilities` separately. Neither it nor modeld ready proves a model replied. | [send](send.md) |
| `hostCapabilities` is missing / incompatible | Compare the loaded component/profile cause; a new source checkout is not proof the running Host loaded it. | [adopt](adopt.md) |
| `operation-busy` after an interrupted Host change | Inspect `runtime operation-recovery --json`; only proven stale metadata can be explicitly recovered. Do not remove locks manually. | [adopt](adopt.md#interrupted-controller--identity-operation) |
| Host `unknown` or source/profile mismatch | Cannot prove channel readiness. Follow the printed recovery next, without guessing flags. | [adopt](adopt.md) |
| Daemon `down` | grokbox services are off. `on` is a change, not a status probe. | [services](services.md) |
| Model use rejects ownership | Inspect ownership/error cause before changing anything. | [ownership](ownership.md) |
| Send is `failed`, `recorded`, or `unknown` | Query the original nonce; do not resend to check status. | [send](send.md), then [diagnostics](diagnostics.md) for gaps |
| Bot keeps Working after a reported stop | Separate parent turn, native children, external workers and App state; do not start with restart or another business send. | [diagnostics](diagnostics.md#a-bot-remains-working-after-its-parent-turn-ends) |
| Title differs from the assignment | Treat it as display evidence, not a silent model rollback. | [label](label.md) |

## Host interruption and stopping rules

Host start/stop/restart can interrupt active Bots, including the operator. A running-Bot refusal requires accepted interruption before the corresponding `--force`; it never bypasses a source/profile mismatch. Do not loop through force/restart commands.

If safe recovery next is exhausted or repeatedly fails, stop and use the verified rollback procedure in [adopt](adopt.md#unrecoverable-failsafe). Do not tell people the computer is back on the official channel until a successful stop and fresh doctor evidence confirm it. If stop is blocked, report that recovery is blocked and leave the unverified state explicit.

Do not switch the operator's brain, edit harness declarations, replay unknown writes, or start a persistent monitor as a workaround. Report the relevant error and what requires maintainer attention.
