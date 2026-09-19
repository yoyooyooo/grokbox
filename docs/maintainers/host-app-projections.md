# Host / App observation boundaries

**Unverified:** exact current App renderer selectors, indicator mounting, cached routing and server overlay behavior. The former private App replay and Host line references do not reproduce on the current files; see [Host loop](host-inbound-agent-loop.md).

| Observation | What it can establish |
| --- | --- |
| Gateway run/activity fields | Returned state for the selected Bot/session and observation time |
| Transcript streaming/delivery entry | State of that entry, not completion of all work |
| Nonce settlement or modeld terminal | That owner's result and identity, not App pixels |
| App screenshot or live view | The displayed state at that time, not the entire execution history |

The managed `activity-bridge` keeps a run-owned native callback. `bun test packages/box-runtime/test/host-activity-bridge.test.ts` tests callback isolation and the absence of a process-global last-listener sink with owned Host-shaped input. It does not validate the current desktop.

Do not infer a missing or stuck indicator from `currentActivity` alone. Compare current session, native run state, message streaming, pending sends and the actual view. [Composer acceptance](composer-working-status.md) keeps the unresolved observation requirement; [Working recovery](working-state-recovery.md) routes operational investigation.

Ownership and transcript routing need separate evidence: [transcript/ownership](transcript-harness-box-vs-server.md). Report only the fields and effects actually observed; do not repair state merely to make a display look idle.
