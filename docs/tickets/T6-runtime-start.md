# T6 — Unified `runtime start` facade

## Goal
One user/agent-facing entry that makes “our runtime path” ready: ensure prerequisite processes, write desired activation, report readiness — without hiding live mutation gates.

## Shape
`grokbox runtime start --mode observe|identity|route`

Implemented order:
1. Ensure `modeld` up — `probeStubModeld`; if down, `startStubModeldServer` in-process (same listen path as `modeld run`, no `wait()`, bound to CLI abort). Reuse a live socket. No second daemon stack.
2. `activate --mode …` (write desired; route uses the same stub assignment checks)
3. Ensure watchdog if required for reconcile — one `runWatchdogTick` for `identity`/`route` only (`observe` skips). Not merged into `daemon serve`.
4. Print `status` via `projectLiveStatus` / probe
5. **Do not** auto `re-adopt --confirm` / canary — default path has no adopt port (`reAdopt: false`, `inject: false`)

Tick is after activate so identity/route see the new desired.

## Why
Today `modeld run`, `watchdog run`, `activate`, `re-adopt` are separate. End users should not memorize the prefab process set.

## Non-goals
- Merging watchdog into `daemon serve`
- Silent Host patch / spend

## Status
**done.** Registry `["runtime","start"]` with required `--mode`. Pure orchestration in `packages/box-runtime/src/runtime-start.ts`; CLI `runRuntimeStart` wires probe/start/activate/tick/status. Default path never calls `runManualReadopt`.
