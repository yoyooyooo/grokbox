# T11 — Pre-dispatch official passthrough + STEP-correlated visible errors

> Publication note: operational identities below are synthetic examples. Private evidence locations and machine execution records are not distributed; historical observations do not qualify a current deployment.

## Goal
Assigned-bot route is availability-first **until** the managed provider has gone out. After dispatch, fail visibly. Never silently replay official.

Debug canary: grok bot `00000000-0000-4000-8000-000000000114`. Other bots stay official via T10.

## Policy (operator-confirmed)

1. **Before provider dispatch**, when Host can still take `originalSession` and there are no partial tool side effects: return `originalSession`.
   - Missing `models.json` / resolve throw / disallowed assignment
   - Missing agent id or missing TURN (`sessionOptions.invocationId`)
   - modeld socket missing (sync handshake-unavailable probe)
2. **After Host holds a managed session** (hook already wrapped): handshake/admit/local submit failures cannot unwrap. Emit a **visible managed error** with `agentId` + STEP `invocationId` + `stage: admit|provider|normalize`.
3. **After provider dispatch / mid-tool**: same visible error. **No** silent official replay. **No** `last_resort_official` executor.

Hook is synchronous, so Unix handshake/envelope admit run inside submit after wrap. Those are visible `stage=admit` errors, not `originalSession`. Session identity conflict (two Bots, one TURN) stays fail-closed visible (`stage=admit`).

Missing STEP at `stream` stays `host_stream_rejected` (not TURN fallback).

## Stages

| stage | when |
|---|---|
| `admit` | handshake, kernel admission, local seam reject after wrap, identity conflict |
| `provider` | driver/provider already dispatched (including mid-tool) |
| `normalize` | Host-facing stream parse after dispatched parts |

VisibleFailure fields: `agentId`, `invocationId`, `stage`. Message appends the same triple so Host `SendToUser` can show it.

## Out of scope

- Silent post-dispatch official fallback
- T3 live Host inject / G1 canary
- T9 spend
- CLI reviewed-copy-envelope WIP / root `src/`

## Status

**done.** Offline: `packages/box-runtime/test/t11-pre-dispatch-visible-errors.test.ts` plus seam/turn/stub-route/events.

## Next

T3 G1 canary on grok bot only, after this contract. Still no silent post-dispatch official.
