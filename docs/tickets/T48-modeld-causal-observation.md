# T48 — Causal observation, diagnostic independence and artifact proof

Status: implemented; final offline aggregation and fixed-tip independent review tracked by T49. Milestone M3. Depends on: [T45](T45-modeld-evidence-lifetime.md), [T47](T47-modeld-authority-state-machine.md). Spec: [S10.6, S10.8](../roadmap/box-runtime-impl-spec.md#modeld-effect-core).

## Goal

Expose what the source did, what each waiter experienced and how far execution progressed without making observation an execution dependency. Carry finite cause and identity once, rather than reclassifying the same incident at every layer.

## Module / files

- Kernel authority/ownership/failure-summary diagnostic contracts.
- Modeld outcome/control frames and Host normalized terminal projections.
- CLI ownership/runtime status and existing monitor diagnostic storage/projectors.
- Existing packaging/import/privacy tests; finite `observation` verifier case.
- Documentation routes from error/case/source to the accepted Spec and source audit.

## Required behavior

Correlate sourceReadId/waiterId/evidenceId/policyId with Agent/TURN/STEP/Host/service identity. Preserve original cause, queue/source/shared/backoff/fence/storage times, remaining source/STEP budget, original evidence age and source-settled-versus-unknown. Missing fields stay unknown rather than reconstructed from nearby logs.

Source health, evidence usability and execution state are distinct. A valid cached observation during a failed refresh does not become an observed revocation; an expired cache cannot authorize. CLI direct diagnostic read still works with modeld absent. Monitor/SQLite outage never blocks independent inference or restores permission. Observation receipts are not model/provider/tool/delivery receipts.

Authority-wait control frames are finite ordered control data, not model output and not deadline extension. Use qualified native state channels only; no fake thinking text or force-running UI. Bounded diagnostic IDs stay in traces/logs; aggregate metrics use finite labels. Never emit raw error/response, prompt, token, account/team/machine ID or endpoint credentials.

## Acceptance

```bash
bun run typecheck
bun run verify:modeld-core -- observation
bun run check:publication
bun run verify:package
```

Fault-inject source cancellation, waiter timeout, generation rollover, unreturned source, native bridge unavailable, diagnostic schema downgrade, malformed control frame, log timeout and SQLite failure. Assert consistent causes through production Unix -> Host terminal -> safe journal -> monitor cold read. Verify caller duration is not substituted for source age. Current/expected wire and Host compatibility observations remain distinct.

Assert malformed or absent diagnostics cannot grant authority or change the original terminal. Verify no modeld dependency for explicit direct ownership diagnosis. Packed Node uses the built graph, Host/preload contains neither Effect nor provider SDK, and no test-only source capability enters the published bundle. Structured privacy tests use sentinel secrets.

## Forbidden / non-goals

No observer repair, new database/version for symmetry, transport-error guessing, fabricated native pixel proof, full App patch, generic collector manager or migration of J13 Host journal ownership. Do not move mandatory ledger persistence into an optional logging queue.

## Exit evidence

The v6 authority progress contract is connected to the production gate, Unix transport, final STEP snapshot and existing append-only journal. Source and waiter IDs, first recovery cause/duration, original evidence age, bounded backoff and separate queue/source/local-witness durations are safely projected. `execution-status` exposes aggregate active/waiting authority contexts and read-retry counts; it does not turn source liveness or cached evidence into permission.

A service-owned, bounded authority-observation queue keeps journal waiting off the execution path, retains identities rather than prompt snapshots, and records dropped/timed-out observation gaps without synthesizing a business failure. The existing journal writer still owns physical backpressure and pending writes; a timed-out observer is not proof that its filesystem operation stopped. Host journal ownership/J13 is unchanged.

`history outcome` projects `runtimeAuthority` with observed time, exact STEP correlation, `currentLiveness:not_proven` and `replayAuthorized:false`. Final outcome snapshots are authoritative about their own detection point; separate asynchronous progress appends may arrive later. Existing monitor storage retains the projected evidence without a database migration or an authorization role.

`authority-observation.test.ts` exercises actual production Unix -> Host -> journal -> real SQLite -> cold read -> CLI projection for source cancellation. It also holds the observer clock while sixteen real fixture STEPs finish, proving the observer does not consume execution waiting time. Wire tests cover malformed controls, independent sequences, old-peer refusal, pre-accepted EOF and read-only v5 identity observation. Final aggregate/build/privacy results and independent/native gates remain T49.
