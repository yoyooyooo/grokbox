# Routines and notification setup

Load for native Routine management, first notification setup, receiver permission, or recovery: `grokbox skills get grokbox --topic routines`.

CLI and Web use the same authenticated management Server. These commands require an existing installation; reads do not initialize storage, start services, create credentials, or send messages. Use the explicit pinned connection when not targeting this Box. Preserve the installation and original principal when recovering an operation.

## Inspect the exact target

```bash
grokbox notification settings get
grokbox notification receiver list
grokbox routine list --bot <bot-ref>
grokbox routine get <routine-ref>
```

A Routine reference includes installation, native Bot UUID and native Routine ID. Names are not mutation targets. Lists omit native prompts and credentials and describe only the returned native window; they never claim complete upstream history. Missing or bad sources are errors, not empty successful lists.

## First setup: separate the effects

Save one explicit notification target and budgets through `notification settings apply --input @file` or `--input -`. The strict JSON request has this shape; replace placeholders and persist the request UUID before submission:

```json
{
  "action": "settings",
  "requestId": "<new-request-uuid>",
  "confirmed": true,
  "expectedRevision": "<revision-from-settings-get>",
  "settings": {
    "alias": "default",
    "botRef": "<bot-ref>",
    "routineKey": "ops-notice",
    "mode": "actionable-user",
    "installationBudget": 2,
    "targetBudget": 2
  }
}
```

This narrow update preserves other targets, advanced routing and system settings. Saving configuration is not granting receiver permission or enabling a native schedule. A changed policy can invalidate existing qualification rather than silently reauthorize it.

`grokbox notification receiver blueprint <alias>` returns the fixed **disabled** reminder definition for the configured key. Put its `data` object in the `blueprint` field of a `routine apply --input @file|-` request:

```json
{
  "action": "apply",
  "requestId": "<new-request-uuid>",
  "confirmed": true,
  "botRef": "<bot-ref>",
  "expectedRevision": null,
  "blueprint": "<replace-with-the-actual-blueprint-object>"
}
```

`expectedRevision: null` is for first creation. Updating an existing managed key requires its observed revision and preserves the native ID. Definitions remain disabled after apply; there is no hidden enable or invocation. Generic supported blueprints can also declare cron schedules, but the notification receiver uses the fixed webhook definition.

After successful creation, use its exact result reference and revision. Obtain the existing observation database ID from `notification list` or `system observation get`; absence requires explicit installation/storage work, not a guessed ID.

```bash
grokbox notification receiver bind <alias> --routine-ref <routine-ref> --database-id <database-uuid> --expect-revision <disabled-routine-revision> --expect-binding-revision 0 --request-id <new-request-uuid> --confirm
grokbox routine enable <routine-ref> --expect-revision <disabled-routine-revision> --request-id <new-request-uuid> --confirm
```

Bind requires a disabled, managed exact Routine. It may request/mint a native key **once**, after a durable guard has been saved. The key remains in the private capsule, never in normal output. Bind neither enables the Routine nor authorizes notification delivery. Replacing an explicitly unbound alias requires its current binding revision instead of zero. The native Routine's enable is a separate deliberate change; it does not itself invoke the webhook.

Now independently verify and authorize the receiver returned by bind:

```bash
grokbox notification receiver verify <receiver-ref>
grokbox notification receiver enable <receiver-ref> --expect-revision <binding-revision> --expect-model-revision <verified-model-revision> --request-id <new-request-uuid> --confirm
```

**A test is optional, not a prerequisite for enable.** Verification is read-only, and enable records permission without sending. Future permitted notification deliveries can consume native model usage. Only the automatic reminder task is constrained to a safe short report; this is not a permanent read-only persona for later user-delegated work.

## Optional testing and revocation

```bash
grokbox notification receiver test <receiver-ref> --expect-revision <binding-revision> --expect-model-revision <verified-model-revision> --request-id <new-request-uuid> --confirm
grokbox notification receiver disable <receiver-ref> --expect-revision <binding-revision> --request-id <new-request-uuid> --confirm
grokbox notification receiver unbind <receiver-ref> --expect-revision <binding-revision> --request-id <new-request-uuid> --confirm
grokbox notification status
grokbox notification list
grokbox notification get <notification-ref>
```

Testing has a separate permission and durable test identity. It does not manufacture an incident or enable automatic delivery. Test failure/unknown must not block an independent enable decision. Unbind removes the local credential, not the upstream key or native Routine, and is not secure-media erasure. Native acceptance, Bot execution/report and user read are different facts.

## Durable operation recovery

```bash
grokbox operation get --domain notification-settings --request-id <original-request-uuid>
grokbox operation get --domain routine --bot <original-bot-ref> --request-id <original-request-uuid>
grokbox operation get --domain pairing --request-id <original-request-uuid>
grokbox operation get --domain receiver --database-id <original-database-uuid> --request-id <original-request-uuid>
grokbox operation get --domain notification-test --database-id <original-database-uuid> --request-id <original-request-uuid>
```

Completed lookups return historical receipts, not current state. Repeating a completed pairing cannot mint again, and repeating an old enable receipt cannot revive a revoked grant. Configuration content equality does not prove that a previously uncertain commit succeeded. Preserve unknown operations; do not replace their IDs to force another attempt.

For an unknown **provision** operation, list the exact native Bot and inspect the selected disabled definition before explicitly associating it:

```bash
grokbox operation reconcile --domain routine --request-id <original-provision-request-uuid> --routine-ref <exact-observed-routine-ref> --expect-revision <current-routine-revision> --confirm
```

This performs native reads and settles only the original local provision guard. It never re-creates the Routine or requests a key. A matching current enabled flag cannot prove the history of an unknown enable/disable/delete; this reconciliation does not claim to solve that different problem.

Other native definition changes use the same durable entry:

```bash
grokbox routine disable <routine-ref> --expect-revision <current-revision> --request-id <new-request-uuid> --confirm
grokbox routine delete <routine-ref> --expect-revision <current-revision> --request-id <new-request-uuid> --confirm
```

Native revision preflight and independent readback are **not native compare-and-swap**. Returned-window absence is not global deletion proof. Disabling/deleting does not prove cancellation of in-flight native work. Ordinary `agents routines ...`, `ops targets ...` and the old daemon Routine RPCs are retired, not fallback paths. Remaining protection/handover programs still own their scoped local native primitives; their migration and real upstream qualification are separate.
