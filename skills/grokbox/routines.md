# Native Routine inspection and control

Use this topic when the user asks to inspect, enable, pause or remove an existing native Routine. Routine state belongs to Grok Bot; do not edit automation files or native databases.

## Inspect first

Resolve the Bot using `grokbox agents list --table`, then use its exact UUID. A Routine ID is not its display name.

```bash
grokbox agents routines list <agent-id> --json
grokbox agents routines show <agent-id> <routine-id> --json
```

Results contain a safe definition summary and `revision`, not the prompt, native file path, run output, Webhook URL or key. The upstream list is a bounded returned window: `coverage.complete=false`. Missing from the window does not prove global absence. Unknown trigger shapes and unsupported session bindings are read-only.

## Execute the authorized change

Read the current revision immediately before the change. Substitute that exact value; do not guess it or silently refresh it after a conflict.

```bash
grokbox agents routines disable <agent-id> <routine-id> --expect-revision <revision> --confirm --json
grokbox agents routines enable <agent-id> <routine-id> --expect-revision <revision> --confirm --json
grokbox agents routines delete <agent-id> <routine-id> --expect-revision <revision> --confirm --json
```

These commands require the user's task or an applicable explicit authorization. Enabling can permit later model runs; receiving a diagnostic alert does not authorize it. Disabling or deleting a definition does **not** prove in-flight runs were cancelled. The default alert-receiving task is still to remind and end, not automatically manage Routines.

`requested_state_observed` means the requested flag was read back. `unchanged` means no mutation was needed. Deletion returns `absent_in_returned_window`, not a native transactional deletion receipt. There is no native compare-and-swap; another App or tool may edit the same definition between reads. Report that limitation instead of claiming exclusivity.

A timeout, lost response, generation change or conflicting readback is `operation_outcome_unknown`. Inspect the exact ID and reconcile; do not automatically replay. An `operationId` is correlation only, not an upstream idempotency key. Preserve it when reporting uncertainty.

## Current boundaries

Creation/apply, `--routines-from`, Webhook credential pairing, invoke and outcome tracking are not implemented by these commands. Do not invent their flags, call `runAgentAutomationNow` as a substitute for a Webhook, retrieve credentials just to inspect a Routine, or send a synthetic Human message to simulate a native event. Native credential retrieval may mint a secret and belongs to a separately authorized pairing flow.

These primitives are also usable by a user-delegated Bot maintenance task. They do not create a new scheduler or limit the Bot's other authorized grokbox abilities. Load [send](send.md), [models](models.md) or [diagnostics](diagnostics.md) only when that task needs them.
