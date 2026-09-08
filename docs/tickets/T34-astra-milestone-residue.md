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
