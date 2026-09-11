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

## Grokbox managed-turn risk

Live `create-session` wraps `createCursorInferencePromptSession` so STEP streams come from grokbox `fullStream` instead of Cursor proto `AgentService.Run`. Official proto `thinkingDelta` / `textDelta` therefore never reach `handleAgentUpdate` unless grokbox forwards a Host-shaped update.

Intended restore: slice `activity-bridge` stashes the Host `emitUpdate` sink on `Symbol.for("grokbox.box-runtime.host-activity.v1")`; managed `onFirstChunk` calls `emitHostActivity({ type: "thinking-delta", text: " " })`. Official proto still uses the same sink. Missing sink or throw is a no-op for inference.

No-STEP compact / memory still declines to the original session. HostCompact remains opt-in (`GROKBOX_MODELD_HOST_COMPACT=== "1"` on modeld only).

## Evidence

- Diagnose (2026-09-11): machine-local `PRIVATE_EVIDENCE` — live test2 mid-turn `isRunningTurn=true`, `currentActivity` absent; not tray.
- Host SHA for inbound line pins: [host-inbound-agent-loop.md](host-inbound-agent-loop.md) §1.2 (`H` = `f5cc35b5…` as of 2026-09-10). Recheck before citing new line numbers against a later Host disk SHA.

Do not treat a single Gateway field as “the App looks fine.”
