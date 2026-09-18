# Ownership

Load when custom-model eligibility is blocked or uncertain: `grokbox skills get grokbox --topic ownership`. This inspection does not migrate or repair a Bot.

```bash
grokbox agents ownership <agent>
```

Server registration is the execution fact. Local `harness=` on `agents list` is a declaration, and a title trailer is only display.

| Class | Meaning | Next decision |
| --- | --- | --- |
| `confirmed_box` | Server and local agree box | Eligible for `models use`, not a production sign-off. |
| `confirmed_temporal` | Server owns the temporal execution route | Leave this Bot on official; the custom Host does not see its App turns. |
| `conflict` | Server and local disagree | Stop managed use; do not send or retitle it as box. |
| `unconfirmed` | Read failed or identity is unstable | Inspect the reported reason; recheck ownership without guessing box. |

## Interpret a model-use refusal

`models use --for` refuses before writing for non-`confirmed_box` Bots. Use the returned `error.next`, not a hard-coded repair sequence.

| `error.code` | Meaning | Route |
| --- | --- | --- |
| `runtime_ownership_temporal` | Server/local agree temporal | For a requested custom-model experiment, create a separate box Bot. |
| `runtime_ownership_conflict` | Server/local disagree | Re-read `agents ownership <id>`; do not edit local harness to force agreement. |
| `runtime_ownership_unconfirmed` | Identity is missing or stale | Re-read ownership; report uncertainty if it remains. |
| `runtime_ownership_unavailable` | Host/bridge/server read unavailable | Run doctor and follow the scoped `next`; inspect its cause before assuming identity loss. |

`host_channel_not_enabled` points to the custom channel; `host_source_mismatch` points to profile/source recovery. These are Host-channel gaps, not proof that the Bot changed owner. Load [adopt](adopt.md) for the exact recovery path.

## Create a separate test Bot when appropriate

`grokbox agents create --name "<name>" --harness box` requests box ownership (the default), then `agents ownership` must confirm it. App New Bot is not the operator's custom-model creation path. An unknown create outcome must be inspected, not retried as a second Bot.

If ownership later becomes temporal or conflict, stop managed use for that ID. A refreshed showing trailer can change to `owner=temporal` / `owner=conflict` and drop `m=`; the title does not perform migration. Server remains the ownership authority.

The operator/template Bot stays on the official brain. Continue an eligible, separately authorized test through [models](models.md); unresolved failures route through [troubleshoot](troubleshoot.md).

## Explicit current-state initialization

On a Box with a separately qualified `current-state` Host profile, `grokbox agents state show <uuid>` reads the one current working state. The `capture`, `initialize`, `reconcile`, and `activate` actions require a stable operation UUID and `--confirm`; use their command help for exact arguments. `operation` is an offline receipt read with the original scope ID. There is no session list or switching.

`agents create --harness box --defer-start` requests no introduction or kickstart; it does not establish an input hold. Initialization only accepts an unused target with no old requests, transcript or pending results. It preserves the target's Memory and imports the saved native working context, not a complete Bot clone. Do not clear an existing Bot merely to make initialization pass.

Initialization remains prepared. `activate` releases its verified hold for a later ordinary input; it does not send a user message or start a task. Unknown results must be reconciled under the same operation ID, never replayed with a fresh UUID. Missing capability calls for the governed profile/adoption process, not an automatic update or a hidden send.
