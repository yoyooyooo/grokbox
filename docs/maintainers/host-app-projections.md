# Host / App live projections

> Publication note: operational identities below are synthetic examples. Private evidence locations and machine execution records are not distributed; historical observations do not qualify a current deployment.

**Role: thin living map of what the user sees vs what grokbox actually drives.** Not a second inbound tome. Deep Host pins stay in [Official Host inbound → Agent loop](host-inbound-agent-loop.md) (CP21 live presentation, §6.2 `handleAgentUpdate`, §6.4 tray vs nonce). Product and architecture documents still own accepted grokbox behavior.

This file is for operators who otherwise re-research Working / trays / activity on every managed-turn UI mismatch.

## What is not the same surface

| User-facing mark | Owner | Host / Gateway fact | Not the same as |
|---|---|---|---|
| Sidebar **Working** | Gateway overlay on Host run counts | `isRunning` / `isRunningTurn` from `beginSessionRun` / `inFlightRunCounts` | Composer named activity |
| Trailing/composer-area generic **Working / typing** | App current-session projection of live run facts | App `Ibt`: running + composing choose working/typing; no `currentActivity` prerequisite | Named activity; Bot-wide sidebar aggregate |
| Specific activity label (thinking/tool/wait) | Host activity map or valid server activity overlay, then current-session selector | `handleAgentUpdate` → activity transition → `sessionActivities/currentActivity` | Generic working; message streaming |
| Assistant message streaming | The installed transcript entry | `message.isStreaming` or `send-message.streaming` | Whole TURN or Bot still running |
| Error tray above composer | Host RAM `TrayManager` | SAND-E04xx / classified turn failure on current epoch | Working, `lastTurnSettlement` |
| Turn settlement | Host KV | `lastTurnSettlement` (nonce error/success) | Tray push, activity, App pixels |

**2026-09-12 correction from the actual App 0.47 renderer:** generic Working does **not** require proto deltas or a non-null `currentActivity`. `Ibt/Nbt` selects working from running=true/composing=false; the specific activity label adds richer information. Final indicator mounting also depends on pending/failed sends, permission widgets, group typing and current-session scope. Neither a missing activity field nor a present one alone proves whether the App must spin.

App pixel claims (exact composer chrome, renderer strings, whether a trailing `activity-indicator` is enough) stay **N / notProven** unless a live App poll or screenshot is cited. Host line numbers in the inbound map are pinned to **that document’s SHA**, not to an unnamed live PID.

## Grokbox managed-turn restore

Live `create-session` wraps `createCursorInferencePromptSession` so STEP streams come from grokbox `fullStream` instead of the original inference session's update path. The managed adapter must preserve the Host activity/update contract; do not label this replacement as `AgentService.Run` without exact source evidence.

The current `activity-bridge` slice preserves the native run-owned callback (`streamWatchdog.noteUpdate` and `host.emitUpdate`) without installing a global last-writer activity sink or synthesizing thinking on the first canonical chunk. Older first-chunk activity observations below are historical, not a description of the current bridge. Sidebar run state, native updates and App current-session selection remain separate observation boundaries.

Always-emit roster `harness=box|temporal` does **not** change this path: omit-box and `"box"` both read Host `sessionActivities`. Only `harness === "temporal"` uses the server activity overlay (no `activity-bridge`).

Current compaction substrate: the modeld-to-Host overflow bridge requires `GROKBOX_MODELD_HOST_COMPACT=== "1"`; this is not a global switch for every native compact. Dedicated native summary and the qualified memory/episode purposes have distinct routing and identities. The accepted [S12 local-maintenance target](../roadmap/box-runtime-impl-spec.md#context-maintenance) replaces the normal-function environment gate with default-auto policy and qualified root/operation capabilities, including a separate conversation-compaction request. It is still planned, not a loaded capability. The original App must receive truthful maintenance activity and terminal states through Host events; no App patch, fake model text or perpetual Working. Fault injection (`GROKBOX_MODELD_OVERFLOW_CANARY_*`) stays separate and default-off. Historical canary permission is not standing rollout authority; see [readiness](t32-live-enable-readiness.md).

A missing indicator after valid Gateway activity is a consumer/routing/projection investigation, not proof that the whole product is correct. [Composer Working residual](composer-working-status.md) owns the open check; Cmd-Q/Host unload are not automatic fixes for restored routing.

## Server activity diagnostics

Qualified Hosts expose an optional `activityObservation` through `agents ownership <id>` alongside (not as part of) the ownership decision. The bounded witness observes the **existing** native activity/timer owner: raw running and running-subagent flags, default empty session ID, frame timestamps, server stale interval, computed timer delay, actual arm/failure/settlement receipts, and the current native overlay. It neither creates another Watch subscription nor expires, interrupts, or rewrites native activity. The same finite events use `host_server_activity_observation` in the Host journal. Missing hooks, evicted sessions and truncated per-Agent results remain explicit gaps.

`isRunning=true` with `isRunningTurn=false` can be a server-reported child-only state. Empty default session IDs are valid and must not be dropped with truthiness filters. A local Box settlement or an empty local child list does not establish that a temporal Agent has no server-side work. Last frame timestamps, calculated expiry and actual timer receipts must be compared before attributing a continuing projection to local stale-state handling.

### Child-only activity and explicit stopping

Fresh child-only frames can renew native expiry while the parent turn is idle. A parent interrupt, an empty local task list, or an absent overlay during reconnection cannot establish that temporal children stopped.

The [持续 Working 操作手册](working-state-recovery.md) owns the reusable triage branches, explicit stop scope, native-owner cleanup, maintenance-message template, independent verification and recurrence limits. This map owns the surface meanings; the runbook does not change ownership, add automatic task cancellation, or turn Gateway evidence into App pixel proof.

A failed optimistic send is not evidence of Bot execution. It can remain in the App send journal without any matching server or Host transcript entry; do not resend or delete it to diagnose the indicator. Reload/restart changing its position proves a difference in reconstructed client projection, not delivery. Native App pending-send state and server child activity must be investigated separately.

## Evidence

- Pre-bridge diagnose (2026-09-11): machine-local `PRIVATE_EVIDENCE` — mid-turn `isRunningTurn=true`, `currentActivity` absent; not tray. **History**, not the current 8-slice compile.
- Post-bridge Gateway prove: machine-local `PRIVATE_EVIDENCE` — after `first_chunk`, raw `listAgents.currentActivity` was `{ kind: "thinking" }`. App pixels still N.
- Host SHA for inbound line pins: [host-inbound-agent-loop.md](host-inbound-agent-loop.md) §1.2 (`H` = `f5cc35b5…` as of 2026-09-10). Recheck before citing new line numbers against a later Host disk SHA.

Do not treat a single Gateway field as “the App looks fine.”

## Transcript source (pointer)

History, live run/activity and per-entry streaming are different surfaces, but must share the selected conversation route and scope. App `yW` uses a temporal row to replace run/composing/activity with server state; a wrong harness can therefore corrupt both history selection and Working. Mac's inspected roster cache does not itself contain live working fields; cached routing can indirectly select the wrong live source. See [Transcript harness](transcript-harness-box-vs-server.md).

Private original-source map and test0-versus-test2 observations live in `PRIVATE_EVIDENCE`; the isolated original-renderer replay is `scripts/verify-desktop-working-projection.cjs` in that research repository (7 assertions, not live GUI proof). Current test0 is box in both Gateway and inspected Mac roster, unlike test2's temporal cached row. Do not reinterpret test0's historical context-amnesia closed-notProven as a proven routing fork. No private App source is vendored into grokbox.
