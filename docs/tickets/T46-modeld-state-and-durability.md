# T46 — Execution identity synchronization and bounded maintenance

Status: implemented / offline verified; fixed-tip independent review pending. Milestone M2. Depends on: [T44](T44-modeld-service-lifetime.md); consumes T45 types but storage work can be prepared independently. Spec: [S10.3, S10.5](../roadmap/box-runtime-impl-spec.md#modeld-effect-core).

## Goal

Remove avoidable cross-Bot head-of-line blocking while preserving durable claim-before-effect, exact duplicate/conflict evidence, original TURN binding and old-service fencing. Move unbounded cold-resource maintenance off the request critical path. Effect is not a database transaction and moving I/O outside a lock is not sufficient.

## Module / files

- `runtime-kernel/src/internal/inference/route-binding.ts`, `step-ledger.ts`, `step-program.ts`: state ownership, per-identity synchronization and bounded maintenance.
- `runtime-kernel/src/internal/inference/execution-history.ts`: canonical atomic identity-storage operations where needed.
- `box-runtime/src/internal/io/execution-history.node.ts`: one existing LevelDB owner and explicit sync/atomic write semantics.
- Existing cooling/storage/lifetime/ledger tests plus deterministic contention tests.

## Required behavior

Global counters/index changes are short and bounded. Same TURN/STEP operations serialize by identity; external storage waiting for one Bot does not retain an unrelated global mutation lock. If work is performed outside a global lock, validate the identity/revision before publication; never overwrite a newer cancel or binding.

Persist a claim and required identity metadata before provider dispatch. An unknown write acknowledgement keeps the STEP unavailable for replay, never returns it as a fresh unclaimed request. Do not relax sync durability, delete the exclusive DB lock or fall back to in-memory storage on production failure. Keep original model/selection/fingerprint after cold reactivation; prior binding must not be overwritten by a cache miss.

Maintenance processes a bounded number of inactive candidates per cycle and releases real TURN scopes only after metadata is safely persisted. Failed release remains tracked; the first STEP ending cannot release another STEP's TURN owner. Avoid request-wide full sorting/scanning/persisting of all inactive turns. Lifetime request count is not an admission quota.

## Acceptance

```bash
bun run typecheck
bun run verify:modeld-core -- state
```

Required vectors: same-STEP concurrent duplicate/conflict; same-TURN sequencing and cancel; slow storage for Bot A with Bot B's safe independent progress; capacity reservation under concurrent new claims; failure before/after persistent acknowledgement; cancel during write; cold restore preserving original fingerprint and selection; failed cold read not erasing binding; thousands of terminal STEPs without lifetime quota; bounded maintenance batches and release counts; storage corruption/ENOSPC equivalent refusal; old service after restart cannot replay.

Use actual temporary LevelDB for storage semantics and controlled capability barriers for contention. Compare atomic write/revision behavior, not wall-clock sleeps. Record storage versus lock wait separately. A source-shaped expectation alone is not concurrency proof.

## Forbidden / non-goals

No second ledger, new database, distributed actor system, non-durable claim, global uninterruptible request, speculative cross-restart continuation or deletion of duplicate evidence to reduce memory. Observation logs cannot repair or authorize execution. No live DB mutation.

## Exit evidence

Production uses TURN-keyed mutation ownership and short validated global commits; storage I/O no longer holds the global mutation lock. `ExecutionHistory.putIdentity` publishes STEP and TURN in one synchronous LevelDB batch. Cancellation intent fences dispatch before its own persistence can settle. Maintenance uses an advisory inactive-key queue and finite per-pass work; each committed identity is reported independently, not as a fictitious cross-identity rollback.

Validated with the declared Bun 1.3.14: typecheck and `verify:modeld-core -- state` (39 tests in five suites). Includes blocked A / progressing B, same-STEP competition, cancel-during-write, illegal bypass writer, bounded/partial maintenance, real disk batches, unknown acknowledgements, 12,000 STEPs and 4,096 TURNs. Native release, real ENOSPC and independent review are not implied by these offline tests. Fixed-tip review and final release aggregation remain T49.
