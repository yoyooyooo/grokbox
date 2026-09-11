# E07 Path B Host admission

**D2 approved by the owner on 2026-09-11; the Host purpose seam is implemented.** Qualification is bounded to source + packed, independently authored Host-shaped consumers. The complete E07 matrix remains **partial** (`e07_full_matrix_not_qualified`), not a Path B closure or native/live qualification.

## Exact purpose sites

The reviewed Host shape has two auxiliary factories:

- `runMemoryExtraction` passes a fresh `session.getExecutor()` to `extractMemories`.
- The interval branch of `runTurnMemory` passes a fresh executor to `summarizeEpisode`.

Their text collector calls synchronous `stream(ctx, undefined, undefined, {})`. The usage middleware forwards all four arguments unchanged. `recordMemoryEvidence` returns before either auxiliary site; dedicated external summarization is separate, and self-summary retains its own STEP. Only these interoperability facts are required; native prompts, Memory policy and stores are not reproduced here.

`LIVE_SLICE_PATCHES` adds **`memory-purpose` and `episode-purpose`**. Two small literal replacements preserve the one-find-per-slice contract rather than relaxing uniqueness or copying a Host function. Each wraps its existing executor through `grokbox.box-runtime.host-aux.v1`, passing its literal purpose, the real `ctx.get(requestIdKey)` TURN and the original context. The source/anchor/find/transformed/compile gates remain exact. Both slices are required for this admission proof; older profiles and profiles selecting only one optional capability remain structurally legal.

## Parent provenance and lifetime

1. `mainSessionOptions` supplies the real Agent/TURN. `bindHostSessionHook` captures the managed model and selection revision once for that session.
2. The session observes an actual main `stream` STEP and its successful response. Starting another main attempt immediately invalidates the previous parent; a late older completion cannot restore it. No executor count or message content participates.
3. `wrapHostAuxExecutor` mints a distinct auxiliary UUID for that executor. An in-memory WeakMap capability crosses the usage wrapper in the options object, not in prompt/provider data. It is not a public body field. Original options are restored before managed validation.
4. At stream time the same managed session checks the call-site TURN/context and binds that intent to its completed parent. `attachHostAuxStreamContext` then emits `grokboxAux` with Agent/TURN/STEP/model/selection revision. A reused intent cannot migrate to a new parent.
5. Existing modeld generation, selection, parent-seen, tools, duplicate and lifetime fences still apply. This seam adds no re-pin, authority store, provider loop or Memory writer.

Missing hook is inert. Unassigned sessions and dedicated external requests stay official. Untagged no-STEP streams retain their existing official passthrough; they are **not** classified as auxiliary. A known auxiliary intent with no valid parent is rejected on the managed path, not retried officially. Bad purpose, missing parent fields, or auxiliary id equal to parent STEP leave the caller's context unchanged. Context and main executor state are not mutated.

The native text-only consumer needs one additional boundary check: canceled auxiliary streams must throw rather than finish as an empty/partial successful extraction. The wrapper preserves synchronous handles and replayable streams, but rejects that cancellation before the consumer can commit Memory. Provider/half-stream errors likewise cannot become collected Memory text.

Bounded `host_seam_stage` / `stream_enter` evidence may carry `auxPurpose` and `parentStepId`, with `stepId` identifying the auxiliary request. These are adapter facts, not model output or proof of Host Memory persistence.

## Reproduce the proof

Use the repository's declared Bun version and Node 20+:

```bash
bun run typecheck
bun scripts/pack-runtime-helpers.mjs
bun test packages/box-runtime/test/e07-host-admission.test.ts \
  packages/box-runtime/test/e07-host-purpose-e2e.test.ts \
  packages/box-runtime/test/e07-host-purpose-packed.test.ts
bun scripts/verify-context-continuity.mjs --lane contract-e2e --json
bun scripts/verify-context-continuity.mjs --lane artifact-e2e --json
```

- Admission tests cover profile allowlists, missing/duplicate anchors/finds, SHA refusal, inert legacy profiles, unchanged invalid contexts and bounded evidence projection.
- Source Host-shaped tests cross the actual hook, usage-forwarding fixture, Unix modeld and SDK with owned fake HTTP. They check parent provenance, independent Memory results, evidence-only/external/self-summary branches, invalid/stale/duplicate/tool requests, cancellation and half-stream failures.
- Packed tests launch **Node with the built preload and exact compile profile**, not an exported source constructor. They check compile/profile/preload hashes, both purpose sites, missing parent, cancellation, partial failure and a deliberately old four-slice profile that fails the positive behavioral oracle.
- Optional `live-copy.test.ts` only reads a local Host copy, applies the approved recipe and syntax-compiles it. It never runs native Host code; absence of that private input is not public CI qualification.

The verifier reports `E07.hostAdmission.status=pass` only when that lane's required tests execute. Overall E07 stays partial: the complete native consumer/state lifecycle matrix is not established here. E09/native, E10 and E11 obligations remain separate. Packed proof is not loaded-live proof; any live refresh still goes through the existing confirmed operation, never a hand-cleared circuit or manufactured attestation.

See [managed continuity](managed-context-continuity.md), [T34 residue](../tickets/T34-astra-milestone-residue.md) and [review ledger](review-ledger.md). Machine-specific hashes, commands and deployment decisions belong in the execution receipt, not this public repository.
