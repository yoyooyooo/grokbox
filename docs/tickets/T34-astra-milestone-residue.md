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
