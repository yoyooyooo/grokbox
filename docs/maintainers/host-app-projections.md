# Host / App live projections

> Publication note: operational identities below are synthetic examples. Private evidence locations and machine execution records are not distributed; historical observations do not qualify a current deployment.

**Role: thin living map of what the user sees vs what grokbox actually drives.** Not a second inbound tome. Deep Host pins stay in [Official Host inbound → Agent loop](host-inbound-agent-loop.md) (CP21 live presentation, §6.2 `handleAgentUpdate`, §6.4 tray vs nonce). Product and architecture documents still own accepted grokbox behavior.

This file is for operators who otherwise re-research Working / trays / activity on every managed-turn UI mismatch.

## What is not the same surface

| User-facing mark | Owner | Host / Gateway fact | Not the same as |
|---|---|---|---|
| Sidebar **Working** | Gateway overlay on Host run counts | `isRunning` / `isRunningTurn` from `beginSessionRun` / `inFlightRunCounts` | Composer named activity |
| Composer-above **Working** / named activity | Host activity map, then Gateway `currentActivity` | proto `onUpdate` → `handleAgentUpdate` → `trackActivityFromUpdate` → `sessionActivities` | Sidebar Working, tray |
| Error tray above composer | Host RAM `TrayManager` | SAND-E04xx / classified turn failure on current epoch | Working, `lastTurnSettlement` |
| Turn settlement | Host KV | `lastTurnSettlement` (nonce error/success) | Tray push, activity, App pixels |

Sidebar Working does **not** require proto deltas. Composer-above Working **does**.

App pixel claims (exact composer chrome, renderer strings, whether a trailing `activity-indicator` is enough) stay **N / notProven** unless a live App poll or screenshot is cited. Host line numbers in the inbound map are pinned to **that document’s SHA**, not to an unnamed live PID.

## Grokbox managed-turn restore

Live `create-session` wraps `createCursorInferencePromptSession` so STEP streams come from grokbox `fullStream` instead of Cursor proto `AgentService.Run`. Official proto `thinkingDelta` / `textDelta` therefore never reach `handleAgentUpdate` unless grokbox forwards a Host-shaped update.

Slice `activity-bridge` stashes the Host `emitUpdate` sink on `Symbol.for("grokbox.box-runtime.host-activity.v1")`; managed `onFirstChunk` calls `emitHostActivity({ type: "thinking-delta", text: " " })`. Official proto still uses the same sink. Missing sink or throw is a no-op for inference. Sidebar Working can appear at `beginSessionRun`; composer `currentActivity` waits for that first chunk.

Always-emit roster `harness=box|temporal` does **not** change this path: omit-box and `"box"` both read Host `sessionActivities`. Only `harness === "temporal"` uses the server activity overlay (no `activity-bridge`).

No-STEP compact / memory still declines to the original session. HostCompact remains opt-in (`GROKBOX_MODELD_HOST_COMPACT=== "1"` on modeld only). Overflow canary intercept is a separate default-off modeld pair (`GROKBOX_MODELD_OVERFLOW_CANARY_*`). Owner unlocked that live path 2026-09-11 evening; unset stays off. See [t32-live-enable-readiness](t32-live-enable-readiness.md).

Desktop composer-above miss after Gateway `currentActivity` is already set is the [Composer Working residual](composer-working-status.md) (App pixels / coordinator Cmd-Q / official unload) — not a missing tip slice.

## Evidence

- Pre-bridge diagnose (2026-09-11): machine-local `PRIVATE_EVIDENCE` — mid-turn `isRunningTurn=true`, `currentActivity` absent; not tray. **History**, not the current 8-slice compile.
- Post-bridge Gateway prove: machine-local `PRIVATE_EVIDENCE` — after `first_chunk`, raw `listAgents.currentActivity` was `{ kind: "thinking" }`. App pixels still N.
- Host SHA for inbound line pins: [host-inbound-agent-loop.md](host-inbound-agent-loop.md) §1.2 (`H` = `f5cc35b5…` as of 2026-09-10). Recheck before citing new line numbers against a later Host disk SHA.

Do not treat a single Gateway field as “the App looks fine.”

## Transcript source (pointer)

Historical bubbles are a different surface from Working / tray. Stock App/Host may paint Cursor server transcript while box `store.db` has the `SendToUser` rows. Grokbox intercept requires Host `harness=box`; CLI `--harness` always sends the field, and Host `updateAgent` does not persist it (offline Host source). See [Transcript harness: box vs temporal](transcript-harness-box-vs-server.md).
