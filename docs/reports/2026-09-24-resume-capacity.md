# Compact resume capacity attribution · 2026-09-24

Base: `03c1c90b6b67d8682c9ab402bf49f30788920fa3`.
Reviewed implementation: `65b8dae9c6345ecde60dc791b6e28c94de42e341`.
This report adds no runtime changes.

## Reproduction and disposition

AH-176's source-review question is confirmed as an error-attribution defect, not
an observed duplicate-inference or false-success incident. Two bounded cases use
the original modeld server, compact adapter and STEP owner with synthetic external
capabilities. One delivers a deterministic data event to an owned server socket;
the other sends actual Unix socket bytes. Both exceed the original receive ceiling
by one byte during compact resume, without changing production limits.

On the original implementation, both receive exactly one error terminal with
`overflow_candidate` instead of the detecting transport failure `capacity`. Adding
only the missing `onLate` notification changes both results to `extra_keys`:
the waiting Effect had eagerly constructed that error before overflow occurred.
The final patch selects the cause after the Deferred resolves and reuses that same
halt effect in admission and streaming. No new owner, timer, retry, nonce or budget
is introduced; compact's original finalizer remains responsible for resume flags.

The final tests require exactly one inference attempt, one capacity terminal, one
observation with capacity and zero active STEPs, cleared socket/fiber counts, and
no new inference when the original STEP is queried again. The authentication lease
is retained by the existing TURN cache, not leaked by the settled STEP; its release
is checked after the owning service scope closes. An initial test expectation of
zero leases before that scope closes was corrected after inspecting `pinOnTurn`
and the cache owner, without changing production lease semantics.

## Verification

Declared Bun 1.3.14 with the unchanged frozen lockfile:

| Check | Actual result |
| --- | --- |
| Compact adapter, STEP deadline, overflow recovery | 34 pass, 0 fail |
| Modeld lifecycle/wire/outcome/defect, ledger/cooling and the above | 79 pass, 0 fail, 10 files |
| Original context-maintenance control/lifetime/boundaries and network boundary | 35 pass, 0 fail, 4 files |
| Root and Web type checks | Passed |
| Complete build | Passed |
| Documentation checks | 16 pass, 0 fail |
| Working-tree publication scan | Passed, no findings |
| Independent source review of the exact implementation commit | Accepted, no P0/P1 |

Counts overlap and are not added. A requested `check:boundaries` script does not
exist and was not counted as passed. The cross-domain command also included an
absent `context-maintenance.test.ts` argument; Bun ran ten actual files, not eleven.
No claim of that absent suite's execution is made.

A separate Pi reviewer using `sub2api-codex/gpt-6-astra` with max thinking inspected
the exact diff and relevant caller/ownership paths read-only. It did not implement
the patch or independently rerun the tests. Its acceptance is limited to this patch,
not the whole integrated candidate. The review session remains under the feature
worktree's `.scratch/ah176-review-sessions/`.

## Evidence limits

The real Unix socket is an isolated fixture transport, not a production Host,
provider or Bot. No active Host/modeld, configuration, global shim, desktop or user
Bot was changed. This closes the specific AH-176 review question for AH-162; it does
not close complete-candidate independent review, AH-156 platform qualification,
AH-123 adoption readiness, or any later live or user-acceptance gate.
