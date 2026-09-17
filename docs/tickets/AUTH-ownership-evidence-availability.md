# AUTH — Ownership evidence availability follow-up

Status: implemented; scoped offline and native-source-copy qualification passed; final aggregate/full-suite verification and independent fixed-tip review pending. Source baseline `f8c82c0`. Branch `feat/ownership-evidence-availability`. Depends on T45/T47/T48; release and independent review gates remain T49. Specification: [S10.4](../roadmap/box-runtime-impl-spec.md#modeld-effect-core). This ticket follows the completed core slices without reopening their historical receipts.

## Goal and policy decision

Avoid repeatedly acquiring a still-qualified remote observation within one claimed STEP, and explain freshness/qualification failures without implying that ownership changed. A successful List is an observation, not an execution lease.

The fixed `strict-observation-v2` policy keeps the five-second request-start maximum age, two-second cross-STEP cache window, ten-second cumulative authority allowance, existing read retry limits and 180-second ingress deadline. Only a process-local identity issued by the live STEP owner may reuse its already validated source beyond the cross-STEP cache window, and never beyond the original five-second age. Each checkpoint still obtains current local witnesses and surrounding deployment evidence. No age renewal, RTT subtraction, adaptive widening, background refresh or new execution mode.

This is an explicit observation-frequency tradeoff, not merely a performance refactor: compared with re-reading at every checkpoint after two seconds, same-STEP reuse may observe a remote-only registration change later, within the existing five-second conservative client observation window. Neither policy proves instantaneous revocation or Server snapshot consistency. An observed invalidation must fence reuse immediately. Native per-Agent/per-TURN coverage and final tool-consumer qualification remain required and cannot be inferred from allowed/bound booleans.

## Skeleton and ownership

- `runtime-kernel/src/ports.ts`, `inference/authority-gate.ts`: the claimed STEP supplies an opaque process-local evidence owner; it is not a wire field or a permit. Existing budget/cancel/lifecycle ownership remains unchanged.
- `box-runtime/src/internal/io/ownership-coordinator.node.ts`: bounded service-owned source entries; weak STEP-to-operation associations hold no additional evidence payload. Local witnesses, identity validation, invalidation and original-age checks run on reuse.
- `runtime-kernel/src/internal/contract/{authority-policy,ownership-observation,authority-progress,stream-diagnostic,execution-status}.ts`: versioned policy observation and finite non-authoritative failure explanation. Historical v1 observations remain readable, never selectable execution policies.
- `runtime-kernel/src/internal/contract/authority-presentation.ts`: one pure ownership failure message/action mapping used by STEP presentation and CLI refusal. No unconditional Host-start or title-sync recovery.
- Existing source adapter, gate, Unix/Host/journal/incident consumers remain the only execution chain. No new service, provider dependency, database or package.

## Offline acceptance

1. Production coordinator plus kernel: persistent 2.5/3/4-second reads, multiple tool checkpoints and finish; qualified same-STEP reuse reduces full reads without a duplicate model call or budget renewal.
2. Long preparation/inference, stale first read followed by a fresh read, persistent over-age reads and final credential delay: either recover within the original limits or report the actual terminal cause. Held results are not re-inferred.
3. Distinct STEP/owner, different Agent, scope/generation changes, pause/unbound, observed invalidation, cache eviction, cancellation and teardown cannot borrow or resurrect permission. No extra retained payload or orphaned source.
4. Read-duration, subsequent evidence expiry, permit expiry and cumulative wait exhaustion remain distinct finite diagnostics. Unknown historical causes are not invented. Current and historical policy IDs are safely projected; invalid IDs/getters/secrets are rejected.
5. CLI/STEP presentation preserves backend/tool counts and no-replay guidance. Access, bridge, temporal, conflict, stale and timeout do not share an unconditional restart suggestion.
6. Typecheck, targeted tests, rebuilt authority/evidence/observation and release-offline aggregates, full suite and publication checks. Receipts must identify actual commands and source; overlapping suites are not summed as unique tests.

## Live-only acceptance

Register feature-scoped entries in [LIVE integration validation](LIVE-integration-validation.md), linked to the committed implementation. Required: fixed-artifact Host/Gateway source sharing and cancellation, native pause/identity invalidation, long-approval final tool consumption, original App warning/wait/terminal projection, and loaded artifact/policy compatibility. Default validation uses a fixed integrated v2 candidate in an authorized window, not this unmerged worktree. No model spend, restart, adopt or automatic message replay is authorized by this ticket.

## Non-live blockers and proof limits

Independent fixed-tip review belongs here/T49, not in LIVE as a substitute for code review. A missing live environment does not excuse an executable offline regression. Deployment hot-path caching and removal of the Server gate require an effective invalidation protocol/native capability proof and are not silently included.

## Receipts

Initial scoped verification passed with pinned Bun 1.3.14 / Effect 4.0.0-beta.107: typecheck; 104 availability tests across eight suites; 28 read-only native-source tests across six suites. The latter uses the fixed `7920c2f6e28a4f9790d802d60f4b036cbf92676409ebb8b180c7ee6a53834192` native input and checks that installed source/PIDs remain unchanged; extracted snippets run only with substitute capabilities. It does not qualify the loaded feature or actual Server/tool/App behavior.

The first release-offline run found one stale preload digest expectation (471 passed, one failed); it was updated to the rebuilt artifact while retaining drift/empty-artifact refusal. The first full run found four CLI tests asserting the superseded restart/create guidance (2084 passed, six native skips, four failed). Those assertions now check the exact read-only guidance; an old snapshot with no detailed cause remains `server_read_unavailable` rather than being guessed to be a stopped Host. Both real CLI suites were added to the availability verifier. Final fixed-source reruns are still required below; no failed run is counted as a pass.

Implementation audit checked owner scope, original-age preservation, local/deployment revalidation, invalidation during the final local witness, bounded payload retention, error projection and call/terminal accounting. This is the implementer's audit, not an independent review receipt. Independent fixed-tip review remains a non-live requirement in this ticket/T49; no new external reviewer invocation or review pass is claimed.

No live execution, restart, adopt, model spend, source merge or release is claimed. Final source-bound command receipts and LIVE registration follow in a separate documentation commit.
