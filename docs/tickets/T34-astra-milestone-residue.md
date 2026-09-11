# T34 — Astra milestone residue (accumulation)

> Publication note: operational identities below are synthetic examples. Private evidence locations and machine execution records are not distributed; historical observations do not qualify a current deployment.

## Status
**Open · process ticket · never on the default grok main chain.**

Collects concerns Astra still holds after a milestone’s normal loop:

1. Astra reviews the milestone  
2. grok fixes P0/P1  
3. Astra re-looks once  
4. Hand back to grok only (fix more or advance; no further Astra round-trips)  
5. **Astra async final audit** appends remaining issues here — **not** handed to grok  

Owner reviews this ticket at the end of the rebuild; assistants must **not** auto-trigger that final user review or auto-dispatch these items onto grok.

## Goal
Accumulate “Astra still disagrees / grok declined or failed to clear” items across M1–M7 so the owner can later triage what was skipped under schedule pressure.

## How to append (Astra only)
For each milestone final audit, append a dated section:

```md
## M? / T?? — <SHA tip> — <YYYY-MM-DD>
- Relook report: `PRIVATE_EVIDENCE`
- Disposition: still-open after grok handoff
### Items
- **ID** (from relook): one-line claim; evidence path; why not forced onto grok
```

Do not rewrite history of earlier sections. Do not reopen closed P1s that Astra already marked closed in the relook unless new tip evidence reintroduces them.

## Non-goals
- Not a substitute for T20–T33 acceptance.
- Not a queue for grok between milestones.
- Not authorization to pause the main chain.

## Related
[impl-spec S9](../roadmap/box-runtime-impl-spec.md#proof) · milestone loop in agent memory · M1 relook `PRIVATE_EVIDENCE`

**Current integration tip `pre-publication-revision` (2026-09-11):** later E07/HSO/T29/T32 work did **not** close SHA-pinned M1–M4 residue. See [Tip pre-publication-revision status](#tip-pre-publication-revision--2026-09-11) for what that tip settled vs what remains owner-triage.

## M1 / T20 — pre-publication-revision — 2026-09-08

- Reviewed SHA: `pre-publication-revision`; source references below are pinned to this SHA, not the current branch tip.
- Relook report: `PRIVATE_EVIDENCE`
- Scope: final disposition of P1-02/03/05 only. T21 `pre-publication-revision` and later commits are excluded.
- Disposition: one still-held concern, accumulated for owner end-of-rebuild triage only; no grok dispatch, main-chain pause, or new review loop.

### Closed at this M1 tip

- **P1-02 — closed:** Host registry / `parameters` / `schema` / `jsonSchema` decoding now belongs to `hostToolsToCanonical` / `buildHostEnvelope` in `packages/box-runtime/src/internal/host/context-codec.ts:53–87`; session uses that path, while kernel canonical tool validation rejects Host wrappers. The frozen-M1 Host-envelope suite passed 26 tests / 125 assertions.
- **P1-05 — closed at the material-preservation boundary:** `test/fixtures/retired-poc/inference-oracles.json` and `control-cli-oracles.json` under `packages/box-runtime/` now preserve the named concurrency, generation cancellation, restart/no-rehandshake, disconnect/stop, and CLI half-success/argv-redaction inputs, barriers and expectations. These remain unactivated materials, not proof that the replacement runtime behavior is implemented. Previously closed findings are not reopened.

### Items

- **P1-03 — still held: import-time proof remains fail-open.** The four relook counterexamples now fail correctly, and the frozen-M1 architecture suite passes 20 tests / 20 assertions. However, `scripts/check-runtime-boundaries.mjs:278–290` catches import exceptions, ignores the trap subprocess exit/error, accepts empty stdout as `{}`, and only records four `node:fs` write functions. Bounded fixtures with a throwing preload or `process.exit(7)` still return checker exit 0 / `ok:true`; an async `node:fs/promises.writeFile` also returns green while creating its synthetic sentinel in the isolated evidence directory. Thus a green gate still does not establish successful, side-effect-free preload import. This is a remaining proof-surface concern, not an observed live Host incident.
  - Evidence: `PRIVATE_EVIDENCE`, `preload-throws.stdout.log`, `preload-exits.stdout.log`, `preload-fs-promises.stdout.log`; reproducible harness: `audit-m1.mjs` in that directory.
  - Why not forced onto grok: the normal M1 review/relook/handoff is over; this ticket deliberately reserves the residual disagreement for the owner's final triage. No runtime fix or new milestone gate is authorized by this entry.

### Evidence ceiling

Validation used a Git-object-checked archive of `pre-publication-revision`, with workspace imports resolving inside that snapshot; only existing third-party tools were linked in. Actual toolchain: Bun 1.4.2 / Node v24.18.0. No T21 attribution, live/provider operations, runtime edits, full build/package verification, or Bun 1.3.14/Node20 release claim. Final audit note: `PRIVATE_EVIDENCE`.

## M2 / T21 — pre-publication-revision — 2026-09-08

- Reviewed SHA: `pre-publication-revision`; source references below are pinned to this M2 tip, excluding later main-chain work.
- First review: `PRIVATE_EVIDENCE`
- Relook report: `PRIVATE_EVIDENCE`
- Grok residual receipt: `PRIVATE_EVIDENCE`
- Disposition: relook-held P1-01/P1-04 are closed on the named counterexamples; one still-material P2 is retained for owner end-of-rebuild triage. P1-02/P1-03 remain closed and are not reopened. No grok handoff or main-chain pause.

### Closed at this M2 tip

- **P1-01 — closed:** `systemText` in `packages/box-runtime/src/internal/backends/ccs-codec.ts:27–36` rejects non-text system parts instead of filtering them. The Host-accepted state-root text/image snapshot fails with `unsupported_content`, HTTP 0 and API-key argument reads 0 for both Chat/Responses; plain-text system controls each reach mock HTTP once.
- **P1-04 — closed on the held schema/count gaps:** `packages/box-runtime/test/ccs-codec.test.ts:139–208` compares complete call/result arrays and tool name/description/parameters. AST-extracted, unchanged tip oracles reject the prior missing-parameters and same-message duplicate-result mutants on both APIs; both unmodified actual SDK request bodies pass.

### Items

- **P2-01 — still material: snapshot parsing and immutability are not yet a complete canonical boundary.** `packages/runtime-kernel/src/internal/contract/snapshot.ts:31–56` still accepts a synthetic `role:"alien"`, invalid `toolChoice`, and a digest that is only format-valid; the encoder then emits an empty message list. `packages/box-runtime/src/internal/host/context-codec.ts:118–130` still returns a mutable system root: changing its content after construction leaves the old digest in place and makes it disagree with recomputed content.
  - Evidence: `PRIVATE_EVIDENCE` (`parser`, `mutability`); reproducible probe: `probe.ts` in that directory.
  - Why retained / not forced onto grok: the contract is intended to cross future adapter/wire boundaries, so strict content validation, stable snapshots and digest/byte-validation ownership still need explicit proof before that use. At this SHA the parser has no production caller found in the runtime source scan; this is not an observed live admission bypass and is not promoted to P1. The normal milestone loop is over; reserve it for the owner's final triage rather than dispatching another fix or pausing the main chain.

### Evidence ceiling

The audit used a Git-object-checked `pre-publication-revision` archive with workspace imports resolved inside it. `codec` passed 11 tests / 176 assertions; independent real-SDK/mock-fetch controls and the four held oracle mutants produced the dispositions above. Actual toolchain: Bun 1.4.2 / Node v24.18.0, AI SDK 5.0.253 / OpenAI provider 2.0.125. No production fixes, provider spend, live operations, full build/package or pinned Bun/Node20 release claim. Evidence directory: `PRIVATE_EVIDENCE`; final note: `PRIVATE_EVIDENCE`.

## M3 / T27 — pre-publication-revision — 2026-09-08

- Reviewed SHA: `pre-publication-revision`; all source/evidence below is pinned to this tip, excluding later main-chain work.
- Relook report: `PRIVATE_EVIDENCE`
- Grok residual receipt: `PRIVATE_EVIDENCE`
- Disposition: still-open after grok handoff, narrowed to two remaining publication/proof concerns under the original P1-02/P1-03 IDs. The named relook counterexamples are fixed; P1-01 remains closed and is not reopened. Owner end-of-rebuild triage only; no grok dispatch, main-chain pause, or further review loop.

### Verified fixes at this M3 tip

- **P1-02 — held payloads fixed:** `projectSafeIdentity` / `copyInferenceTupleOrReject` in `packages/runtime-kernel/src/internal/status/projection.ts:26–56` rejects the unsafe provided Agent ID before Host append. The actual writer returns `unprojected`, with no corresponding log row or sentinel in CLI stdout/stderr. Control `phase`/`outcome` nested objects are now dropped before NDJSON. Valid full/missing tuples still round-trip, so the closed P1-01 is not reintroduced.
- **P1-03 — held open/write mutant fixed:** `packages/box-runtime/test/observe-status.test.ts:478–492,531` now counts write-mode `fs.promises.open`. The same indirect-path `open(...,"a")` / `handle.write` mutant changes write from 0 to 1 and makes the complete status gate exit 1 / `ok:false`.

### Items

- **P1-02 — still held in the control-log header:** `packages/box-runtime/src/internal/io/journal.node.ts:209–213,372–375` copies `at` directly into the output and skips its validation. An actual `appendEvent` with a valid control event name and a synthetic credential sentinel as `at` persists that sentinel in raw NDJSON; the reader/CLI later reports an invalid row without leaking it, but cannot retract the raw-log publication. This is an incomplete write-side schema boundary, not an observed real-credential leak; the relook Agent-ID and nested-field fixes above are not disputed.
  - Evidence: `PRIVATE_EVIDENCE` (`controlHeader`, with the fixed controls in `hostTupleField` / `allowedFieldVariants`); reproducible `probe.ts` alongside it.
  - Why not forced onto grok: the milestone review/relook/handoff is over. Retain this narrower publication concern for owner triage rather than creating another fix round or stopping the rebuild.
- **P1-03 — still held for equivalent direct file writes:** the new spy observes `fs.promises.open`, not all writes through that module. A status-path mutant using `fs.promises.writeFile(ownedFixture, syntheticLine, {flag:"a"})` bypasses the counter: the full gate returns exit 0 / `ok:true`, 39 + 23 passing tests / 226 + 189 assertions, while the isolated marker contains 27 actual synthetic writes. The marker is outside each test's input data root, so input-tree snapshots do not prove global zero side effects. This is a remaining gate-coverage gap, not evidence that the unmodified status implementation writes files.
  - Evidence: `PRIVATE_EVIDENCE`, `held-open-write.stdout.log`, `sibling-write-file.stdout.log`, `sibling-write-file-owned-marker.ndjson`; reproducible `mutants.mjs` alongside them.
  - Why not forced onto grok: the original open/write counterexample is genuinely fixed; the broader readonly proof remains incomplete. Reserve that residual disagreement for the owner's final triage, without another grok handoff or a new main-chain gate.

### Evidence ceiling

Git-object-checked `pre-publication-revision` archive; workspace imports resolve inside the frozen snapshot or isolated mutant. Original status gate passed 39 + 23 tests / 226 + 189 assertions, layout passed 20 tests / 20 assertions, and read-only typecheck passed. Actual toolchain: Bun 1.4.2 / Node v24.18.0. HOME/TMPDIR and default CLI observation adapters were isolated; real egress/signals were blocked, with zero blocked attempts recorded. Only synthetic inputs/owned fixtures were used, and cleanup targets were retained by rename. No production fixes, live/provider operations, full build/package or pinned Bun/Node20 release claim. Evidence directory: `PRIVATE_EVIDENCE`; final note: `PRIVATE_EVIDENCE`.

## M3 / T23 — pre-publication-revision — 2026-09-08

- Reviewed SHA: `pre-publication-revision`; this entry records the accepted relook at that exact tip, not later main-chain work.
- First review: `PRIVATE_EVIDENCE`
- Relook report: `PRIVATE_EVIDENCE`
- Disposition: **ACCEPT; P1-01 through P1-05 closed on the held counterexamples and controls.** No closed P1 is reopened. This T23 disposition does not close or supersede the earlier M1/M2/M3-T27 residue. No grok dispatch, main-chain pause, or automatic owner-review trigger.

### Closed at this M3/T23 tip

- **P1-01 — closed:** actual SDK/mock EOF, non-SSE and bad-tool-JSON cases fail `stream_invalid`; absent usage stays omitted. Valid text, interleaved tools and 64 ordered chunks are preserved. The drop-all-SDK-output mutant now fails the full backend gate with four backend-test failures.
- **P1-02 — closed on the cancellation barrier:** the SDK receives an abort signal; Effect completion and lease release no longer await another provider chunk. The abort-honoring mock closes its body; the passive mock is separately cleaned up without claiming it honored cancellation. Late output is not delivered.
- **P1-03 — closed:** post-prepare caller mutations do not change the actual HTTP tools/schema/settings. Unsupported Responses seed fails during prepare with zero credential reads and zero HTTP calls.
- **P1-04 — closed:** the held within-snapshot/config-budget input is rejected at final SDK egress with `envelope_too_large` and zero injected fetch calls; its one prior credential read is not misrepresented as zero.
- **P1-05 — closed:** matching root-owned unseal and Fake-auth/SDK compositions work; sibling-root verify/unseal/infer reject the foreign lease, pin input cannot override the root env, and closed leases cannot be unsealed.

### Items

- None carried forward for M3/T23: the accepted relook identified no remaining P1 or still-material nit/P2 for this closeout. Qualification limits below are not new findings, grok work, or permission to pause the main chain.

### Evidence ceiling

This documentation-only closeout checked the accepted report/artifacts and all 11 recorded source fingerprints against `pre-publication-revision`; it did not rerun runtime tests or open a new review pass. Retained relook evidence: backend 15 tests / 66 assertions, codec 11 / 176, layout 20 / 20, typecheck and actual build passed; the output-loss mutant failed as expected. Actual toolchain was Bun 1.4.2 / Node v24.18.0, Effect 4.0.0-beta.107, AI SDK 5.0.253 / OpenAI 2.0.125. This is not T24/T25/T26, production-root, live/provider, pinned Bun/Node20 runtime or `verify:package` qualification. Evidence directory: `PRIVATE_EVIDENCE`; final note: `PRIVATE_EVIDENCE`.

## M3 / T24 — pre-publication-revision — 2026-09-09

- Reviewed SHA: `pre-publication-revision`; all evidence below is pinned to this residual tip, excluding later main-chain work.
- Relook report: `PRIVATE_EVIDENCE`
- Grok residual receipt: `PRIVATE_EVIDENCE`
- Disposition: **relook-held P1-01/P1-03/P1-04 closed on the held barriers and controls.** P1-02/P1-05/P1-06 remain closed. This T24 disposition neither closes nor supersedes earlier M1/M2/M3-T27 residue; no grok dispatch, main-chain pause, or automatic owner-review trigger.

### Closed at this M3/T24 tip

- **P1-01 — closed:** `dispatchFence` re-reads authority after credential verify. Revocation during the final verify barrier now yields `not_admitted`, with zero backend starts; ordinary config saves still preserve the same TURN binding/model and one pin.
- **P1-03 — closed:** the `inferenceMemoryLayer` owner closes TURN scopes. Two independent STEP scopes retain one live lease while their owner is open; after owner teardown the real auth adapter rejects that lease without manual test disposal. Retiring an unconsumed admission leaves no busy slot or late backend dispatch.
- **P1-04 — closed:** cancel waits for local producer quiescence. While a real Effect finalizer is blocked, cancel has not returned and the next same-TURN STEP is `turn_busy`; after release, cancellation is a typed `cancelled` failure, the old resources are released, and the next STEP proceeds without overlap (peak owned backend count 1). Cancellation during verify starts no backend and no longer yields successful empty EOF. This does not claim an external provider honored cancellation.

### Items

- None carried forward for M3/T24: no still-held P1 or new material P2/process concern was identified in this bounded final audit. The qualification limits below are not new findings, grok work, or permission to pause the main chain.

### Evidence ceiling

Git-object-checked `pre-publication-revision` archive; all five residual changed files match the target blobs and workspace imports resolve inside that snapshot. Binding passed 19 tests / 88 assertions plus composition 2 / 5; backend 15 / 66, codec 11 / 176, layout 20 / 20 and typecheck passed. Independent Deferred/Scope probes used current codec/auth adapters, synthetic credentials and counted backend ports (not paid HTTP); 24 guarded processes recorded zero blocked egress/signals. Actual toolchain: Bun 1.4.2 / Node v24.18.0. No production fixes, live operations, build/package rerun, pinned Bun/Node20 runtime qualification, or T25/T26 acceptance is implied. Evidence: `PRIVATE_EVIDENCE` (`audit-results.json`, `final-scope.json`, command logs); final note: `PRIVATE_EVIDENCE`.

## M4 / T25 — pre-publication-revision — 2026-09-09

- Reviewed SHA: `pre-publication-revision`; all references below are pinned to this residual tip, excluding later main-chain work.
- Relook report: `PRIVATE_EVIDENCE`
- First P1 receipt: `PRIVATE_EVIDENCE`
- Grok residual receipt: `PRIVATE_EVIDENCE`
- Disposition: P1-01/P1-03/P1-04/P1-05/P1-06 are closed on the held counterexamples; one narrower native-cleanup concern remains under P1-02. Owner end-of-rebuild triage only; no grok handoff, main-chain pause, or automatic final review. Earlier milestone residue is unchanged.

### Verified fixes at this M4 tip

- **P1-01/03/04/05/06 — closed on the held cases:** desired route without attestation now rejects with zero HTTP/credential reads; a synthetic committed-attestation control reaches the SDK mock once through default global fetch. Root interruption and peer disconnect stop the cooperative backend and leave listener/socket/fiber counts zero. Late extra data now cancels with `extra_keys`, the receive-growth case no longer accumulates the full 9 MiB, and the illegal v2/garbage terminal is rejected. Prior slow-reader/output-cap controls remain green.
- **P1-02 — partial fixes acknowledged:** the competitor pathname now survives, and public stop surfaces injected release failure as `cleanup_gap` instead of claiming success. Path preservation alone does not establish safe native-handle teardown.

### Items

- **P1-02 — still held: competing-path cleanup does not yet have a clean Node20 process proof.** `packages/box-runtime/src/internal/modeld/unix-listen.node.ts:52–60,80–86` clears the private `_handle`/`_pipeName`, closes the raw fd with `closeSync`, then marks release successful and listener count zero. Replaying the owned competing-socket scenario under `/usr/bin/node v20.19.2` preserves the competitor pathname/listener and prints zero owned counters, but the process subsequently terminates with **SIGABRT** (exit status null). An earlier replay also ended abnormally. Thus the original pathname-loss counterexample is fixed, but the replacement cleanup path cannot be accepted as safe resource release; the exact native assertion is not inferred without a native stack.
  - Evidence: `PRIVATE_EVIDENCE`, `node-competitor.json`, `node-competitor.stdout.log`, `node-run-3348566.json`; first observation retained as `node-competitor-initial.*`. Reproducer: `node-probe.ts` / `run-node.mjs` alongside them. All sockets and the preserved hard link are owned review fixtures, not a live Host or competitor service.
  - Why not forced onto grok: the milestone review/relook/handoff is over. This remaining A9/native-lifetime concern is reserved for owner triage; no new fix round, alternate implementation, or pause is authorized here.

### Evidence ceiling

Git-object-checked `pre-publication-revision` archive; eight residual changed files match target blobs and workspace imports resolve within it. Lifecycle passed 14 tests / 47 assertions, binding 19 / 88 plus composition 2 / 5, backend 15 / 66, codec 11 / 176, layout 20 / 20 and typecheck. Actual toolchains: Bun 1.4.2 / Node v24.18.0 for gates, `/usr/bin/node v20.19.2` for isolated Unix probes. The native process failure above is not overridden by green Bun gates; guard exit records do not cover an aborted process's finalization. No production fixes, live/provider spend, build/package rerun, full committed-attestation CLI binary qualification, or T26 acceptance. Evidence directory: `PRIVATE_EVIDENCE`; final note: `PRIVATE_EVIDENCE`.

## M4 / T26 — pre-publication-revision — 2026-09-09

- Reviewed SHA: `pre-publication-revision`; all source/evidence below is pinned to this residual tip, excluding later main-chain work.
- First review: `PRIVATE_EVIDENCE`
- Relook report: `PRIVATE_EVIDENCE`
- First P1 receipt: `PRIVATE_EVIDENCE`
- Grok residual receipt: `PRIVATE_EVIDENCE`
- Disposition: the named seam-facts failure is fixed and P1-06/P1-07 are closed on the held cases. Tip evidence reintroduces a narrower root/profile-provenance concern under P1-02; the existing P2-01 removal item is also retained. P1-01/P1-03/P1-04/P1-05 remain closed. Owner end-of-rebuild triage only; no grok dispatch, main-chain pause, automatic owner review, or additional review loop.

### Verified closures at this M4 tip

- **P1-02 — wiring repair acknowledged:** preload now supplies compile facts; the unchanged LIVE-shaped caller reaches SDK mock HTTP once without adding profile/ABI/digest fields to sessionOptions. Missing root still rejects, and no fixture root text is invented. The qualification concern below does not dispute this repair.
- **P1-06 — closed:** the early unsupported-image rejection records its own STEP, without duplicating the previous STEP or borrowing its serviceEpoch/binding/attempt. Missing-STEP rejection and normal full-tuple rows remain correct; journal failure leaves the reply intact and does not repeat inference.
- **P1-07 — closed:** the first-chunk/terminal-Deferred case now runs through the production modeld root and SDK mock. The formerly green production-fetch deny mutant fails (14 pass / 1 fail), as does the buffer-all mutant. The original stream gate passes 15 tests / 66 assertions; true streaming is not in dispute.

### Items

- **P1-02 — still held, narrowed to root/profile provenance:** `packages/box-runtime/src/internal/host/modeld-produce.node.ts:29–36,107–112` chooses `t21-state-root` / `t21-independent-root` and `host-abi-v1` from message shape or independentRoot presence; `session-hook.ts:55,84–93` consumes compile.transformedSha256 but does not bind root qualification to the supplied compile/profile identity. Under Node20, a consistent synthetic compiled profile declaring independent-root but providing only state-system input is relabeled `t21-state-root` and reaches SDK HTTP1. An unsupported compiled profile is likewise relabeled and dispatched (HTTP1, two synthetic credential-getter reads in each case). Proper state/independent positive controls also work. Thus successful root preservation does not establish the profile-bound provenance required by impl-spec S4/S8; this is not evidence of a live unauthorized adoption, real credential leak, or paid request.
  - Evidence: `PRIVATE_EVIDENCE`, `node-source-seam.json`, `node-roots.json`, `final-scope.json`; reproducer: `node-probe.ts` / `run-node.mjs` alongside them. The wire observer records request and accepted frames; qualification comparisons select the request carrying snapshot/HostEpoch.
  - Why not forced onto grok: the normal review/relook/handoff is complete. Preserve this remaining source-of-qualification disagreement for owner triage, without another implementation round or a new main-chain gate.
- **P2-01 — still material explicit removal debt:** `packages/box-runtime/src/internal/host/session.ts:20–24,83–117,333,424–437` retains the internal toolCalls alias, its response normalizer/PromptSession wrapper, and the fixture helper's default 1/1/2 usage. The residual receipt explicitly leaves the alias unproven. This confirms the original T26 removal-contract item, not a new finding or evidence that current managed inference invents usage or replays tools; the default-usage helper is not the managed producer's billing source.
  - Evidence: the Git-blob-checked source at this tip, the first/relook reports above, and `PRIVATE_EVIDENCE`. Retained for owner cleanup triage only, not a grok handoff.

### Evidence ceiling

Five residual changed files match the target Git blobs; workspace imports resolve inside the frozen archive. Frozen Bun 1.3.14 with 90s gate bounds passed stream 15/66, hook+journal 10/62, and typecheck. Seven bounded `/usr/bin/node v20.19.2` scenarios include the four qualification vectors, real Unix/SDK mock streaming, and actual Host journal writes; completed guard records show zero blocked egress/signals. Only synthetic inputs, owned sockets and retained cleanup targets were used. No production fixes, live/provider spend, build/package/lifecycle rerun, T28 work or supersession of earlier T34 residue. Evidence: `PRIVATE_EVIDENCE`; final note: `PRIVATE_EVIDENCE`.

## M4 / T28 — pre-publication-revision — 2026-09-09

- Reviewed SHA: `pre-publication-revision`, parent `pre-publication-revision`; all source references below are pinned to this residual tip. Later T22 `pre-publication-revision` is excluded.
- Ticket: [T28 controller cut](T28-runtime-controller-cut.md). First review: `PRIVATE_EVIDENCE`; single relook: `PRIVATE_EVIDENCE`.
- Residual receipts: `PRIVATE_EVIDENCE` and `PRIVATE_EVIDENCE`. Final audit: `PRIVATE_EVIDENCE`.
- Disposition: receipt closures are acknowledged on their named cases. New tip evidence narrowly reopens P1-02/P1-04 below; the original P2-01 source-removal debt remains. P1-01 is closed on the held inspect cases; P1-03/P1-05 remain closed. Owner end-of-rebuild triage only: no grok/inv-pi handoff, main-chain pause, automatic owner review, or further review loop.

### Verified closures at this M4 tip

- **P1-01 — closed on the held inspect cases:** invalid profile JSON, unrelated objects and malformed hashes now yield `invalid-source`, `unreviewed-profile` and `invalid-compile`. Optional compile mismatch and malformed coordinator data reject separately; matching synthetic controls retain `live-not-proven`, with zero controller mutation attempts. This is not proof of live Host identity/adoption or permission to remove the fail-closed boundary.
- **P1-02 — original atomicity/corruption cases closed:** two real Node20 processes return acquired/busy even while the first is paused after reading the empty store and before publishing its record. Corrupt/null stores now return `store-corrupt`; terminal/unknown records still absorb repeats after Layer reconstruction, with controlled signal count 1. The narrower resource-ownership cases below do not dispute these fixes.
- **P1-04 — named repairs acknowledged:** typed action failures do not invent completed flags, defects are reported as `defect`, and interruption remains Failure. With a healthy checkpoint, the actual file store retains the completed signal prefix in its unknown record after interruption. The remaining case is checkpoint IO failure, not a demand to turn interruption into success.

### Items

- **P1-02 — still held, narrowed to ownership of the new file lock.** In `packages/box-runtime/src/internal/roots/controller-program.node.ts:159–186`, the exclusive lock is acquired before initial store publication, but its finalizer is registered only after the acquire effect returns. A single injected EIO at the initial rename returns `lease-failed` with zero controller effects and an empty store, yet leaves the lock after Scope completion; a different operation ID then returns `operation-busy`. Separately, `internal/io/op-lock.ts:9–18` releases by pathname alone: replacing the owned lock pathname with another owned fixture while the first Scope is held causes release to remove that competing pathname, while the original lock backup remains. The review deletion guard retained the replacement artifact instead of permanently deleting it; no real competing service was touched.
  - Evidence: `PRIVATE_EVIDENCE`, `tip-replacement-lock.json`, `retention.jsonl`; reproducer `tip-probe.ts` / `run-tip.mjs`. Retain for owner triage; do not dispatch another lock fix or reopen the milestone loop.
- **P1-04 — still held, narrowed to a failed running-prefix checkpoint followed by interruption.** `packages/runtime-kernel/src/internal/commands/controller-operation.ts:182,189,197` ignores checkpoint failures. With real file persistence and controlled actions, one EIO on the completed-signal prefix publication is swallowed and the program enters wait (signal1/wait1/commit0). After interruption the lock is released and the store is unknown, but the confirmed prefix is absent; the healthy control retains `prefix.signaled:true`. Subsequent writes are healthy, so this is not merely an unavailable disk at finalization. The interruption Failure itself is correct; the lost recovery evidence is the residual concern. No second signal or rollback is claimed.
  - Evidence: `PRIVATE_EVIDENCE`, `tip-checkpoint-failure.json`; same reproducer. Retain for owner triage rather than returning nits to grok.
- **P2-01 — original source-removal debt retained:** `packages/box-runtime/src/internal/roots/controller.runtime.ts:65,953–973` and `internal/process/live-inject.ts:131–170` still contain the old LegacyWitness/watchdog/manual/live-inject executors; both files are unchanged since the first T28 review. This is not an assertion of a second active CLI mutator, and no new bundle/reachability claim is made. Evidence: the original review, residual receipt and final audit's Git-blob check; owner cleanup triage only.

### Offline M4 disposition and evidence ceiling

The **T25 → T26 → T28 offline review/relook/residue cycle is recorded**, not converted into blanket implementation acceptance: T25 retains native-cleanup P1-02 (Node20 SIGABRT); T26 retains root/profile-provenance P1-02 and alias/removal P2-01; T28 retains only the items above. Earlier sections and their evidence limits remain unchanged. **L1 live-not-proven is separate and still applies**; this append neither authorizes live adopt nor starts T29/WebUI.

Seven residual changed files and all 374 tracked archive files match `pre-publication-revision`; first-party imports resolve inside the frozen snapshot. Frozen Bun 1.3.14 / 90s gates passed control 37/258, layout 20/20 and typecheck; independent `/usr/bin/node v20.19.2` probes exercised the barriers, file faults and controls above. An initial stock-worker test failure was a review wrapper build-dispatch error, corrected without source/test changes; initial logs and `gate-harness-note.json` are retained. Stock tests terminate only their own lease-worker child handles; independent probes finish normally. Guard records show no blocked egress or direct process.kill attempts, not an OS-level census or proof of finalization of SIGTERM-killed workers. No controller OS signal/spawn/guardian action, live/provider spend, production fix, full product build/package qualification or earlier-milestone re-audit. Evidence directory: `PRIVATE_EVIDENCE`.

## Continuity / E08 — pre-publication-revision — 2026-09-10

- Reviewed SHA: `pre-publication-revision` on `feat/context-continuity-verify`.
- First review: `PRIVATE_EVIDENCE` (P1 N1–N3).
- Absorb: `pre-publication-revision` then `pre-publication-revision` (receipts `PRIVATE_EVIDENCE`, `PRIVATE_EVIDENCE`).
- Relooks: `PRIVATE_EVIDENCE`, `PRIVATE_EVIDENCE`.
- Disposition under one-pass closure: **E08 accepted as partial/shippable offline slice**. Prior R-N2/R-N3 closed on tip. Relook2 leftover **N4** is residue only — **no further grok↔Astra absorb on this tip**. Owner end-of-rebuild triage; no main-chain pause for this item alone. B remains open (E07/E09–E11, packed/native/live, production W still out).

### Closed at this tip

- E08-N1 real size gates / encoded 8MiB backend path.
- E08 R-N2 full over-envelope checkpoint/reopen (and over-snapshot/cancel paths).
- E08 R-N3 consumer error propagation + held-late tool ID (stream-exception false-greens red).

### Items

- **E08-N4 — abort finish counted as live delivery (test fixture consumer).** `packages/box-runtime/test/context-continuity-fixture.ts` treats any `finish` part as delivery-qualified; real session `abort()` emits `finish("abort")` with zero model/tool output, yet consumer still records live delivery (pre-admit abort HTTP=0 and post-admit abort HTTP=1). Late E08 callback can false-green after main abort. Minimal fix (when owner picks it up): require successful completion reason before delivery; keep observed tools; add pre/post/tool-after abort controls. Not a production Host delivery claim; do not reopen the E08 milestone loop.
  - Evidence: `PRIVATE_EVIDENCE` §N4; tip tests still green under frozen Bun 1.3.14.

### Evidence ceiling

Offline contract-e2e only; no packed preload, native Host, live adopt, or production `contextWindowTokens`. One-pass closure applied after second relook; sibling tip to be FF'd into integration `feat/box-runtime-v2` without a third absorb.

## Continuity / E07 Path A — pre-publication-revision — 2026-09-10

- Reviewed SHA: `pre-publication-revision` on `feat/box-runtime-v2`.
- First review: `PRIVATE_EVIDENCE` (Path A recommended; P1 N1–N3).
- Absorb: `pre-publication-revision` (`PRIVATE_EVIDENCE`).
- Relook: `PRIVATE_EVIDENCE` — **ship for Path A honest-partial only**.
- Disposition: verifier no longer false-passes E07; helper lifetime/tools tightened. **E07 remains `unavailable` / `auxiliary_unqualified`.** Full F5/Path B (aux request-kind, captured parent binding, same managed selection) is residue — **no further absorb on this tip**. Owner triage; B stays open.

### Closed at this tip (Path A)

- N1 false E07 contract-e2e pass → unavailable/notProven.
- N2 abort/stale/partial cannot yield ok Memory.
- N3 only `undefined`/`[]` tools; registry/string/non-empty array refuse pre-dispatch.

### Items

- **E07 Path B / F5 — still held:** grokbox aux request-kind + parent binding exist; **Host admission does not.** Live memory/episode call sites still have no purpose seam (D2). E07 stays `auxiliary_unqualified`. Do not add a live aux-purpose slice without D2. See [e07-path-b-host-admission](../maintainers/e07-path-b-host-admission.md).
  - Evidence: `PRIVATE_EVIDENCE` §N1/Path B Acceptance; relook confirmation in `PRIVATE_EVIDENCE`.

## Continuity / E09 Path A — pre-publication-revision — 2026-09-10

- Reviewed SHA: `pre-publication-revision` on `feat/box-runtime-v2`.
- First review: `PRIVATE_EVIDENCE` (P1 N1–N2; recommend honest partial).
- Absorb: `pre-publication-revision` (`PRIVATE_EVIDENCE`).
- Relook: `PRIVATE_EVIDENCE` — **ship for Path A honest-partial only**.
- Disposition: E09 no longer false-passes; Bun smoke vs Node load separated. **E09 remains unavailable / `e09_reject_old_oracle_not_qualified`.** Full reject-old pin/behavior oracle and packed E01–E08 session factory are residue — **no further absorb on this tip**. B stays open.

### Closed at this tip (Path A)

- N1 false E09 pass from non-executable reject-old oracle / name.includes.
- N2 Bun-only smoke no longer mixed into Node/artifact E09 pass.

### Items

- **E09 full reject-old oracle — still held:** needs independent pin/currentness + real old-vs-source failure consumption before any E09 pass claim.
- **Packed E01–E08 session factory — still held:** `packed_preload_does_not_export_session_factory`; artifact lane remains fail-closed.
  - Evidence: `PRIVATE_EVIDENCE`, `PRIVATE_EVIDENCE`.

## Tip pre-publication-revision — 2026-09-11

Integration tip `pre-publication-revision` on `feat/box-runtime-v2`. This section does **not** rewrite SHA-pinned M1–M4 items above. It records what later slices settled or deferred, so the owner does not re-dig closed queues.

### Settled or deferred on this tip (not T34 reopen)

| Queue | Tip settlement | Still T34? |
|---|---|---|
| T32 live overflow / Sub2API small-W / 4 MiB pads | Owner: HostCompact **default-off**; offline gates enough; live dogfood deferred ([t32-live-enable-readiness](../maintainers/t32-live-enable-readiness.md)) | No — parked, do not re-dig |
| E07 Path B grokbox aux request-kind | Landed `pre-publication-revision`; Host purpose seam still D2; E07 `auxiliary_unqualified` | Host D2 only |
| HSO-4 lexical + Acorn workers | Landed `pre-publication-revision` / `pre-publication-revision`; SlicePatch emit / two-slice Host / `_compile` mutant deferred | HSO-4 remainder, not M1–M4 |
| T29 command/API incubate | Landed `pre-publication-revision`; no console/, no fake CAS | Browser MVP / real second-writer CAS still owner-gated |
| T32 v4 wire + Host CF + classifier + readiness | Landed W-T32-A…D; GATE stays unset | Live enable not a tip gate |

### Still open residue (owner triage; not grok main chain)

Ranked smallest-first:

1. **E08-N4** — continuity fixture treats `finish("abort")` as live delivery. Smallest *code-ready* residue if owner wants a slice; test-only, no Host mutation.
2. **E07 Host purpose seam (D2)** — live memory/episode call sites still omit `grokboxAux`. Blocked on Host slice approval; helper exists.
3. **E09** — reject-old oracle + packed session factory; artifact lane fail-closed.
4. **HSO-4 remainder** — emit literal SlicePatch from bindings; synthetic two-slice Host behavior; preload `_compile` mutant.
5. **T29 remainder** — configuration command use case; CAS only when a real second writer exists; browser MVP separately authorized.
6. **SHA-pinned M1–M4 leftovers** (unchanged; still not grok dispatch): M1 P1-03 import-time proof fail-open; M2 P2-01 snapshot parse/immutability; M3 T27 journal `at` header + status `writeFile` spy gap; T25 P1-02 Node20 SIGABRT cleanup; T26 P1-02 profile-bound root provenance + P2-01 toolCalls alias; T28 P1-02 lock ownership / P1-04 checkpoint-then-interrupt / P2-01 legacy executor removal.

### Smallest next residue slice

**If code:** E08-N4 fixture consumer (abort ≠ delivery). **If docs-only / no dispatch:** this section is enough; do not auto-start E07 D2, E09 packed factory, T29 CAS, or T32 GATE.
