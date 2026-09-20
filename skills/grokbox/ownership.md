# Ownership

Load when custom-model eligibility is blocked or uncertain: `grokbox skills get grokbox --topic ownership`. This inspection does not migrate or repair a Bot.

```bash
grokbox agents ownership <agent>
```

Server registration is the execution fact. Local `harness=` on `agents list` is a declaration, and a title trailer is only display.

| Class | Meaning | Next decision |
| --- | --- | --- |
| `confirmed_box` | Server and local agree box | Eligible for `bot model set`, not a production sign-off. |
| `confirmed_temporal` | Server owns the temporal execution route | Leave this Bot on official; the custom Host does not see its App turns. |
| `conflict` | Server and local disagree | Stop managed use; do not send or retitle it as box. |
| `unconfirmed` | Read failed or identity is unstable | Inspect the reported reason; recheck ownership without guessing box. |

## Interpret a model-use refusal

`bot model set` refuses managed selection for non-`confirmed_box` Bots. The new API classifies admission as `permission_denied`, `source_unavailable` or `invalid_input`; those codes do not authorize an alternate route. The remaining `agents ownership` inspection reports the detailed native class below. Reset only withdraws managed intent and does not require managed admission.

The new API's `error.details.admissionCode` identifies the native refusal without exposing the bridge's private response. The following categories guide inspection, not automatic recovery.

| Admission Code | Meaning | Route |
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

## Background protection and retained history

The management Server owns default discovery, observation, material capture and policy-bound successor/handover work. Newly discovered Bots must have fresh, owned Box evidence. The default alert/resume policy preserves materials where supported; it does not authorize automatic replacement. Explicit exclusions remain excluded. Missing or stale sources do not prove ownership loss.

```bash
grokbox system protection get
grokbox bot protection get <original-bot-ref>
grokbox bot snapshot list --bot <original-bot-ref> --limit 20
grokbox bot snapshot get <snapshot-ref>
grokbox bot handover get <handover-ref>
```

These queries read bounded metadata, not private recovery content, and do not initialize a store or contact the native source. The original Bot reference never silently resolves to a successor; inspect the separate current/previous identities and retained handover links. A saved snapshot does not prove native import, and an active successor does not prove that duties completed or that the old Bot may be deleted.

Policy changes use `bot protection set --input @file` or `system protection set --enabled true|false`, an original request UUID, the observed config revision and explicit `--confirm`. Reset removes only the selected override, not history. Lost replies are recovered through `operation get --domain protection --target <original-bot-ref-or-system> --request-id <uuid>`; do not submit a replacement request. Disabling protection does not erase recovery materials or restart paused Routines. Old `agents protection` commands are retired. Notification delivery remains separately authorized and observed.

## Manual clone, replacement and startup

Formal `bot clone`, `bot replace` and `bot spawn` use the pinned management Server, never a local or daemon fallback. Supply a strict JSON declaration through `--input @file` or `--input -`, with a caller-persisted requestId, optional name/modelId/instructions and explicit effect choices. The command supplies kind and source; do not duplicate those fields in the file. Startup requires `lifecycle.start` in addition to `lifecycle.write`; user-authored handover notices require `lifecycle.messages` and `allowHandoverMessages: true`.

```bash
grokbox bot clone <source-bot-ref> --input @lifecycle.json --preview
grokbox bot clone <source-bot-ref> --input @lifecycle.json --scope-id <preview-scope> --expect-plan <preview-plan> --confirm
grokbox bot spawn --input @startup.json --preview
grokbox operation list --domain lifecycle --limit 20
grokbox operation get --domain lifecycle --scope-id <original-scope> --request-id <original-request>
grokbox operation resume <lifecycle-operation-ref> --domain lifecycle --expect-plan <original-plan> --confirm
```

Preview does not store a workflow or create a Bot. Repeated submission reads the original immutable plan; explicit resume can continue only its safe stages. A native creation marked effect_unknown is never sent again. Source/model/policy drift requires inspection, not an automatic fresh request. Retained phases, actual target usability, startup completion and source retirement are separate facts. Clone defaults prepared; replace activates and has independent handover duties; spawn activates and requests one program startup, not a user message or guaranteed temporary cleanup. The original actor retains authority: legacy local handover and background protection cannot inherit it. `/lifecycles` is observation only, not a task composer.

## Explicit current-state initialization

On a Box with a separately qualified `current-state` Host profile, `grokbox bot context get <uuid>` reads the single current native context through the management Server. `bot snapshot create --bot <ref>`, `bot context initialize/reset/restore` and `bot activate` require the original request UUID, exact account scope, reviewed native revision and explicit confirmation. `operation get --domain context --scope-id <original-scope> --request-id <original-uuid>` reads retained history without the Host. `operation reconcile --domain context --bot <ref> --scope-id <scope> --request-id <uuid> --confirm` only reconciles original evidence. `operation resume <context-operation-ref> --domain context --bot <ref> --confirm` continues safe stages of that same plan, never a new apply after an uncertain application. The old `agents state` routes are retired; there is no session list or switching.

`agents create --harness box --defer-start` requests no introduction or kickstart; it does not establish an input hold. Initialization only accepts an unused target with no old requests, transcript or pending results. It preserves the target's Memory and imports the saved native working context, not a complete Bot clone. Do not clear an existing Bot merely to make initialization pass.

Initialization, reset and restore remain prepared. `bot activate` releases only the hold belonging to the original application marker for later ordinary input; it does not send a message or start a task. Release uses its first reviewed revision; a lost result can be read via `activationExpectedRevision` and the same native idempotent release, never by importing the source again. `operation cancel <context-operation-ref> --domain context --bot <ref> --confirm` is limited to preparation with no native application declaration at all. Unknown application cannot be cancelled into new permission. Context changes, activation and history need context.write, context.activate and operations.read respectively. Missing capability calls for the governed profile/adoption process, not an automatic update or a hidden send.
