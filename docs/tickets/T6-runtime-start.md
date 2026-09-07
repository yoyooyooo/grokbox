# T6 — Unified `runtime start` facade

## Goal
One user/agent-facing entry that makes “our runtime path” ready: ensure prerequisite processes, write desired activation, report readiness — without hiding live mutation gates.

## Proposed shape (discussion)
`grokbox runtime start --mode observe|identity|route`

Behind it (order TBD):
1. Ensure `modeld` up (reuse process entry / supervise)
2. Ensure `watchdog` up if required for reconcile
3. `activate --mode …` (desired state)
4. Print `status` readiness (modeld ready? coverage? attestation?)
5. **Do not** auto `re-adopt --confirm` / canary unless explicit flags + human gate phrases

## Why
Today `modeld run`, `watchdog run`, `activate`, `re-adopt` are separate. End users should not memorize the prefab process set.

## Non-goals
- Merging watchdog into `daemon serve`
- Silent Host patch / spend
