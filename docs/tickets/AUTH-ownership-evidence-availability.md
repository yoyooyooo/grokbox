# AUTH — Ownership evidence availability follow-up

Status: linearly integrated into v2 and offline/full-suite reverified in the v2 worktree; partial native-source-copy qualification passed; independent fixed-tip review pending; W17 loaded-policy/ordinary native-read/tool vectors exercised, with controlled revocation/approval/App acceptance still open. Source baseline `f8c82c0`. Source branch `feat/ownership-evidence-availability`, integrated tip `8760d3a`. Depends on T45/T47/T48; release and independent review gates remain T49. Specification: [S10.4](../roadmap/box-runtime-impl-spec.md#modeld-effect-core). This ticket follows the completed core slices without reopening their historical receipts. The [v2 integration receipt](#v2-integration-receipt) records exact mappings and revalidation.

## Current live receipt

The authorized [W17 integration window](LIVE-integration-validation.md#window-20260917) now includes actual strict-observation-v2 loading, ordinary real source/STEP/cache observations and native tool consumption. Controlled slow-source, pause/unbound/cancellation, long-approval final execution and original-App vectors remain unproven. Review and the historical unresolved offline anomaly remain source-ticket obligations. The older integration receipts below are historical; current per-vector results and loaded artifacts are recorded only in LIVE and its linked report.

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

Registered entries are [LIVE-AUTH-AVAILABILITY-NATIVE](LIVE-integration-validation.md#live-auth-availability-native), [TOOLS](LIVE-integration-validation.md#live-auth-availability-tools) and [APP](LIVE-integration-validation.md#live-auth-availability-app), each linked to implementation commit `90346bb`. Required: fixed-artifact Host/Gateway source sharing and cancellation, native pause/identity invalidation, long-approval final tool consumption, original App warning/wait/terminal projection, and loaded artifact/policy compatibility. Default validation uses a fixed integrated v2 candidate in an authorized window, rather than switching live to a feature worktree. No model spend, restart, adopt or automatic message replay is authorized by this ticket.

## Non-live blockers and proof limits

Independent fixed-tip review belongs here/T49, not in LIVE as a substitute for code review. A missing live environment does not excuse an executable offline regression. Deployment hot-path caching and removal of the Server gate require an effective invalidation protocol/native capability proof and are not silently included.

## Receipts

Initial scoped verification passed with pinned Bun 1.3.14 / Effect 4.0.0-beta.107: typecheck; 104 availability tests across eight suites; 28 read-only native-source tests across six suites. The latter uses the fixed `7920c2f6e28a4f9790d802d60f4b036cbf92676409ebb8b180c7ee6a53834192` native input and checks that installed source/PIDs remain unchanged; extracted snippets run only with substitute capabilities. It does not qualify the loaded feature or actual Server/tool/App behavior.

The first release-offline run found one stale preload digest expectation (471 passed, one failed); it was updated to the rebuilt artifact while retaining drift/empty-artifact refusal. The first full run found four CLI tests asserting the superseded restart/create guidance (2084 passed, six native skips, four failed). Those assertions now check the exact read-only guidance; an old snapshot with no detailed cause remains `server_read_unavailable` rather than being guessed to be a stopped Host. Both real CLI suites were added to the availability verifier. Final fixed-source reruns are recorded below; no failed run is counted as a pass.

Implementation audit checked owner scope, original-age preservation, local/deployment revalidation, invalidation during the final local witness, bounded payload retention, error projection and call/terminal accounting. This is the implementer's audit, not an independent review receipt. Independent fixed-tip review remains a non-live requirement in this ticket/T49; no new external reviewer invocation or review pass is claimed.

The initial feature-worktree receipt did not include source integration, live execution, restart, adopt, model spend or release. Source integration was subsequently authorized and is recorded below; no live action or release is claimed.

### Fixed-source final receipt — 2026-09-17

Implementation: `90346bb2bd72b44b345eb4752d730c7922d8e809`; branch `feat/ownership-evidence-availability`, parent v2 `f8c82c0`. Source digest `a6eb9fb9ab63052fa22504639c6c529b3301d26c383b817178063bd44496dceb`; rebuilt preload SHA-256 `c00484cf80649b95e920efea862cb744f800b8151942a8d2f050705eea2e6f4d`. Documentation-only receipts do not change these source/artifact digests. Runtime/toolchain pins remain unchanged.

| Executed command (pinned Bun 1.3.14) | Observed result | Claim boundary |
|---|---|---|
| `bun run typecheck` | passed | Current TypeScript source |
| `bun scripts/verify-modeld-core.mjs availability` | 146 passed, 0 failed, 10 files, 1113 assertions | Rebuilt production-path availability, presentation, actual CLI and fixture Unix/Host/SQLite chain |
| `bun scripts/verify-modeld-core.mjs release-offline` | 514 passed, 0 failed, 53 files, 3097 assertions | Rebuilt lifecycle/evidence/state/authority/availability/observation/package/privacy aggregate |
| `GROKBOX_TEST_NATIVE_HOST=0 GROKBOX_TEST_ALLOW_NATIVE=0 bun test --timeout 30000` | final run: 2088 passed, 6 explicit native skips, 0 failed, 267 files, 17257 assertions | Whole-repository offline regression; skips are not passes |
| `bun run test:native-host` | 28 passed, 0 failed, 6 files, 209 assertions | Separately opted-in fixed native-source copies/snippets; includes the six cases skipped by ordinary full tests; no running feature/Server/App qualification |
| `bun test --rerun-each 100 --bail 1 -t 'production root ownership' packages/box-runtime/test/modeld-outcome.test.ts` | 400 passed, 0 failed, 1600 assertions | Bounded repetition of the four refusal paths; not proof of a production failure's root cause |
| `bun run check:publication` and `git diff --check` | passed; publication findings empty | Working-tree publication and whitespace checks, not remote publication |

These suites overlap; counts are not added as unique tests. The availability test deliberately omitting the new owner capability reproduces cumulative-budget exhaustion under persistent three-second reads, while the current STEP-owned capability completes 2.5/3/4-second vectors with one source read and one model call. Expired evidence, new STEP identity, local invalidation, scope changes and permit expiry remain refused or refreshed within the original limits.

### Non-live review residue — do not move to LIVE

A full-suite run on `90346bb` reported one failure in `modeld STEP outcome > production root ownership wrong-gateway refuses a real Host/Unix STEP before provider` (2087 passed, six skips, one failure). The retained console tail identifies the test but not its failed assertion. The unchanged suite then passed individually (11 tests), all four refusal paths passed 100 repetitions each, and a fresh whole-repository run passed as recorded above. No production or test code was changed between those runs. The failure is not reproduced and its cause remains unknown; it is not claimed fixed or attributed to asynchronous logs. Include this evidence limit in fixed-tip independent review. Any recurrence requires retaining the full assertion/stack and fixing the source/test owner before release; live validation cannot resolve or waive this code/test concern.

Independent review remains `review_pending`; the implementer's audit and passing reruns do not sign that gate. The v2 source mapping is now recorded below and in LIVE. The three LIVE entries are `blocked` on review/current-native qualification and an authorized window; target, budget and actual loaded identities remain unselected/unrecorded.

<a id="v2-integration-receipt"></a>
### Linear v2 integration receipt — 2026-09-17

Under the user's explicit integration instruction, both clean worktrees were checked at the exact source refs. v2 had not advanced beyond `f8c82c0abdf2fc16ed54c1d2af559920e6fb8320`; the feature tip `8760d3a09bd36975cf65192585ba0ba3daabc0e5` was exactly two commits ahead. A pre-integration typecheck and rebuilt availability verification passed on that tip. v2 was then fast-forwarded with `git merge --ff-only` to the same exact tip. No rebase, conflict resolution, squash or merge commit was needed, and no unrelated feature branch was included.

| Source commit | Integrated v2 commit | Scope |
|---|---|---|
| `90346bb2bd72b44b345eb4752d730c7922d8e809` | same hash | Ownership availability implementation, tests and source documentation |
| `8760d3a09bd36975cf65192585ba0ba3daabc0e5` | same hash | Feature proof and live-only acceptance registration |

The integrated tree exactly matched the feature tip before this documentation-only receipt. Rebuilt source digest remains `a6eb9fb9ab63052fa22504639c6c529b3301d26c383b817178063bd44496dceb`, and preload SHA-256 remains `c00484cf80649b95e920efea862cb744f800b8151942a8d2f050705eea2e6f4d`. These identify disk artifacts, not running Host/modeld instances. Dependency pins, `strict-observation-v2`, wire v6, original-age and deadline limits are unchanged by integration.

| Actual integration verification, Bun 1.3.14 | Result | Location and boundary |
|---|---|---|
| `bun run typecheck` | passed before and after fast-forward | Exact feature tip, then v2 worktree |
| `bun scripts/verify-modeld-core.mjs availability` | 146 passed, 0 failed, 10 files, 1113 assertions | Rebuilt exact feature tip before fast-forward |
| `bun scripts/verify-modeld-core.mjs release-offline` | 514 passed, 0 failed, 53 files, 3097 assertions | Rebuilt integrated v2 worktree; includes availability and packed/package gates |
| `GROKBOX_TEST_NATIVE_HOST=0 GROKBOX_TEST_ALLOW_NATIVE=0 bun test --timeout 30000` | 2088 passed, 6 explicit native skips, 0 failed, 267 files, 17253 assertions | Fresh integrated v2 whole-repository run |

No source change or HEAD drift occurred during the integrated runs. Suites overlap and are not added as independent tests. The six default native skips remain skips; the earlier 28-test native-source-copy receipt above was not rerun in this integration and does not qualify loaded components. The previously unlocalized `wrong-gateway` failure did not recur in this full run; its root cause remains unknown and the review concern above is retained.

Integration does not sign T49's independent review or any native/live gate. LIVE now records the source mappings but keeps targets, request/cost budgets, cutover permission and actual loaded artifacts unselected. There was no remote push, global shim change, Host/modeld restart/adopt, real provider spend or automatic message replay. The feature worktree and its two original commits are retained.
