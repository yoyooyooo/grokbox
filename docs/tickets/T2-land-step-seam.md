## Goal
Land and verify the offline TURN≠STEP / STEP-slot seam work already done in the worktree (envelope own-snapshot, seam STEP slots, latch, additive v2 events, tests on bun@1.3.14).

## Context
`inv-env` implemented offline STEP slots; 156 tests via `bunx bun@1.3.14`. Mixed unrelated WIP must not be folded into one commit. Event names owner-accepted.

## Scope
- Separate clean commit(s) for seam/envelope/events/tests/docs only
- Confirm bun@1.3.14 + frozen lock evidence
- Leave official-chain / reviewed-copy-envelope / root `src/` alone

## Out of scope
- Live Host patch / second canary

## Driver
Herdr (grok).

## Status
**done** (offline land). TURN≠STEP submit split, STEP slots keyed `(hostGenerationId, STEP)`, omitted/illegal STEP → `host_stream_rejected`, success/reject terminals → `model_step_terminal` (no dual-write of `turn_seam_terminal`). Latch / duplicate-idle / same-executor STEP-2 / S1-abort-↛-S2 covered.

Evidence: `bunx bun@1.3.14 install --frozen-lockfile` (no changes). T2-scoped `bunx bun@1.3.14 test` on seam/envelope/events/session/stub-route/modeld/observation + mechanical CLI follow-on: 178 pass. One remaining CLI fail (`reviewed-copy-envelope`) is excluded WIP in `packages/cli/src/commands/runtime.ts`, not this land. Live-copy H1 `find-missing` is live-bundle drift (T1), not T2. Official-chain / root `src/` left unstaged. No live Host / canary.
