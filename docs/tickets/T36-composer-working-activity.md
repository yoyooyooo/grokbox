# T36 — Composer Working / currentActivity on managed path

> Publication note: operational identities below are synthetic examples. Private evidence locations and machine execution records are not distributed; historical observations do not qualify a current deployment.

## Status
**Open · product residual · queued.** Owner confirmed 2026-09-12: keep unblocking; Spec/Ticket-controlled. Not a substitute for sidebar `isRunningTurn`.

## Goal
On managed / `harness=box` bots (including grokbox orchestrator chat), App composer shows the same class of Working / activity placeholder users see on official bots — driven by honest `currentActivity` (or documented App-owned equivalent), not sidebar-only spin.

## Module / dirs touched
- grokbox activity-bridge / Host `sessionActivities` projection (tip may already emit first-chunk thinking-delta).
- Optional CLI/raw roster honesty if `runningProjection` drops `currentActivity`.
- App/desktop consumption may require grok-bot or owner-machine Cmd-Q / coordinator clear — call out in Acceptance if App-only.
- Maintainer map: `docs/maintainers/composer-working-status.md`, `host-app-projections.md`.

## Depends-on
Living activity-bridge on attested Host helpful but not sufficient. Does **not** depend on T35 live resume.

## Forbidden
Faking Working without a real in-flight turn; unloading Host only to “refresh chrome”; treating harness always-emit as a fix for Working; test1 opt-in; inventing App menus/click-paths without verifying grok-bot docs.

## Acceptance (executable)
1. Documented diff: sidebar `isRunningTurn` vs composer `currentActivity` remains accurate on tip.
2. On an attested managed bot the user cares about (e.g. grokbox or test0): during an in-flight turn, raw Gateway shows `currentActivity` **and** desktop App composer shows Working placeholder (screenshot or owner-confirmed). If App-only gap remains after Gateway-green, ticket records App/coordinator follow-up with owner-machine steps — not “tip done”.
3. Official (non-managed) bot still works (no regression).
4. Short Current Home maintainer note updated; review-ledger row.

## Non-goals
HostCompact resume ([T35](T35-host-compact-wait-point.md)); mobile vs desktop transcript backfill; temporal server overlay Working.

## Related
[composer-working-status](../maintainers/composer-working-status.md) · [host-app-projections](../maintainers/host-app-projections.md) · L4 receipt `PRIVATE_EVIDENCE`
