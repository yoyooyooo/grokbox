# T10 — Per-Bot official passthrough (selective route)

> Publication note: operational identities below are synthetic examples. Private evidence locations and machine execution records are not distributed; historical observations do not qualify a current deployment.

## Goal
Route Host patch may be installed while **only opted-in bots** use modeld. Everyone else keeps the official Host session.

Canary: grokbox test0 `00000000-0000-4000-8000-000000000114`. grokbox test1 `00000000-0000-4000-8000-000000000113` and other bots stay official until opted in.

## Rule
- `assignments.agents[agentId]` set to stub/echo or openai* → modeld (current managed path).
- **No** per-agent override → return `originalSession` (official). Do not invent an `official` catalog sentinel; missing key is official.
- `assignments.main` is optional (CLI without `--for` still writes it) and is **not** a session fallback.
- `activate --mode route` allows agents-only / `main=null`. Present assignments must still be admitted.

## Operator
```
grokbox runtime models use openai-responses/gpt-5.6-luna --for 00000000-0000-4000-8000-000000000114
grokbox runtime start --mode route
```
CLI `--for` takes the stable agent id (no extra name map in this slice).

## Status
**done.** Seam `decideRouteSession`; coordinator no longer requires main; observe routeReady allows null main.

## Next
T11 pre-dispatch passthrough + visible STEP errors (done). T3 G1 canary on grokbox test0 only, after T11.
