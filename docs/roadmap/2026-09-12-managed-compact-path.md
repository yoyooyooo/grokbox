# Managed custom-model path through Host Compact

> Publication note: operational identities below are synthetic examples. Private evidence locations and machine execution records are not distributed; historical observations do not qualify a current deployment.

**Status:** forward plan @ `pre-publication-revision` (2026-09-12). Working / future sequence — not live-enable, not an implementation-complete claim, not a GATE.

**Upper goal (binding):** a Bot opted into a managed custom model must send the Host-selected conversation into that model; when the window is too large, compress through Host Compact, then continue on the compacted context **on the same custom-model binding**.

**Means (separate):** reuse Host Compact up/downstream when it fits. If a segment does not fit, patch at Host’s original Compact-related points. Do not invent a parallel grokbox summarizer, near-window CAP, or `store.db` prepend.

Authority this page does **not** take: [product contract](../product-contract.md) §12, [D3](../decisions/2026-09-08-host-seam-normalization-and-roadmap.md#d3--host-context-and-memory-ownership) / [D11](../decisions/2026-09-08-host-seam-normalization-and-roadmap.md#d11--confirmed-overflow-host-recovery), [T32](../tickets/T32-runtime-confirmed-compact.md) (implementation), [T32 live-enable](../maintainers/t32-live-enable-readiness.md) (GATE / canary). Product narrative is [T14](../tickets/T14-managed-context-compact-on-model-switch.md) / [T14b](../tickets/T14b-host-reuse-compact-on-confirmed-overflow.md).

## Goal

End-to-end, one Bot turn:

1. Host accumulates the conversation (official compact / Memory / pins remain Host-owned).
2. `assignments.agents[agentId]` + `harness=box` wrap `createCursorInferencePromptSession` so every main STEP’s `getExecutor` window goes to the switched custom model via modeld.
3. If that model’s window rejects the Host-selected snapshot (`context_length_exceeded` / `context_too_large`, confirmed, zero released text/reasoning/tools), terminate attempt0 without settling the Host STEP.
4. Same connection: `compact-request` → Host `handleSummarization` rewrites the **Host** root (dedicated official external summarizer) → `resume-step` with a new snapshot.
5. Same TURN / STEP / binding / ServiceEpoch / custom `modelId`: attempt1 once. Unique Host terminal.

“Stay on the custom-model path through compress” means attempt0 and attempt1 stay on the managed model. It does **not** mean the Host summarizer itself must call luna. Dedicated external summary stays official (`forceExternalModel: true`, no `agentId`) so the wait-graph does not deadlock on the busy managed STEP.

## Current bridge map

Already bridged on tip `pre-publication-revision` (offline / default-off). Live compact-request → resume remains **notProven** ([L5](PRIVATE_EVIDENCE), [CF dig](PRIVATE_EVIDENCE)).

```text
Host root / getExecutor window
  → create-session wrap (harness=box only) + agent-id slice
  → modeld v4 run-step (custom model, GATE-off = no HostCompact port)
  → confirmed overflow classifier
  → runOverflowRecovery → sameConnectionHostCompactLayer
  → compact-request on the live socket
  → Host CF resumeStepFrameForCompactRequest → requestHostCompact
  → D2 slot (if ready) → orchestrator.handleSummarization
  → hostToContextSnapshot → resume-step → attempt1
```

| Segment | Where | Reuse fit? |
|---|---|---|
| Selective custom-model route | `assignments.agents[id]`; `create-session` / `agent-id` slices; session-hook captures `modelId` + selectionRevision | Fits. Missing assignment = official passthrough. `harness=temporal` never wraps. |
| Host-selected window, zero CAP | context-codec / D1 / D3 | Fits as product law. F1/F2 metadata fidelity is still a compact-path compatibility gate, not this page’s implement lane. |
| Overflow detect | provider-specific structured 400 / `response.failed`; canary intercept is not real W | Fits as **trigger**. Host S/P / approaching-limit uses official W and broken `maxTokens=0` (M4/F3) — do not reuse as the custom-model trigger. |
| Recovery budget | kernel `overflow-recovery` + `step-program.recoverOverflowStream`; one compact, ≤2 managed attempts | Fits. Same binding/selection; `prepare` + `infer` again on the compacted snapshot. |
| Same-connection wire | v4 `compact-request` / `resume-step`; `same-connection-compact.ts` `COMPACT_WAIT_MS=5s` | Fits as transport. 5s is modeld’s fail-closed bound, not Host’s summarize budget. |
| Host CF | `modeld-client` `applyIncomingFrame` → `resumeStepFrameForCompactRequest` | Fits. No resume → `compact_rejected` → socket destroy (~80ms live). |
| D2 slot + snapshot contract | preload `bindHostCompactHook(stateSystemCompactHookOptions())`; `compact-register` at `let stepClosed` | Bind **fits**. Insert **timing does not** — see below. |
| Host compact core | `handleSummarization(..., forceExternalModel: true, WaitForCompletion, triggerReason: input_token_limit_error)` | Fits. Host owns partition / carrier / tail / archive / root rewrite. Return is a redacted string, not a success object; grokbox re-reads RAM snapshot. |
| Dedicated external summary | Host `isSummarizationSession` / no managed `agentId` | Fits as means. Routing it onto the managed custom STEP **fails** T32 wait-graph. |
| Release | `stepClosed` + `env_2` disposer | Fits. Overflow before register is seam-intentional `capability_not_ready`. |

Living Host disk order (`/home/box/sand-host/host-main.cjs`, L5 SHA `2ede71e2…`) — this is the current Compact-related spine, not the original seam SHA:

1. `stateHandler.lastStepInvocationId = invocationId`
2. `rootPromptExecutor.executeToolStream(...)` — **custom-model / modeld run-step starts here**
3. optional `await startBackgroundSummary()` (`approaching_token_limit`) — may leave `backgroundSummarizationPromiseInfo`
4. `let stepClosed = false`
5. D2 `compact-register` insert (before `Promise.all`)

Seam [T32-host-compact-seam](../tickets/T32-host-compact-seam.md) required register just before the main wait, after tools / background prep. On this bundle, stream start moved **before** `stepClosed`. Fast overflow therefore hits the socket while the slot is still absent (or blocked by a pending background summary).

## Reuse vs must-patch

### Reuse (do not rebuild)

- Host `handleSummarization` + dedicated official summarizer + archive/root rewrite.
- Same-STEP v4 compact-request → resume-step → attempt1 on the captured custom `modelId`.
- Confirmed-overflow classifier and recovery ledger.
- D2 snapshot bind (`t21-state-root` / `host-abi-v1`).
- `harness=box` as the managed intercept prerequisite.

### Do not reuse (wrong Host Compact branch)

- Host `InputTokenLimitError` outer retry (new STEP / new `invocationId`; breaks the T32 ledger).
- Queued `SummarizeActionHandler` (STEP waits compact, queue waits handler).
- Host approaching-limit / S/P as the **custom-model** overflow trigger (official W, M4/F3).
- Self-summary / `responseSummaryLaunch` on the busy managed STEP.
- grokbox near-window, product CAP, `store.db` prepend, second summarizer.

### Must-patch (only if reuse cannot deliver the upper goal)

Patch at Host Compact points, not a new surface:

| Host point | Why reuse fails | Allowed patch shape |
|---|---|---|
| `compact-register` insert (`let stepClosed` / pre-`Promise.all`) | Custom-model overflow is typically **first provider call** (Host window already larger than the switched W). That is the same class as L5’s ~80ms `capability_not_ready`. | New D2-style qualification: register after `lastStepInvocationId` and **before** `executeToolStream`, still release in runStep `finally` / `env_2`. Re-prove wait-graph vs `responseSummaryLaunch` / background. |
| `startBackgroundSummary` await before the slot | Leaves `backgroundSummarizationPromiseInfo` → `requestHostCompact` `blocked` even after the slot exists. Host retries mint a new `invocationId`, so the race repeats. | Narrower: do not `await` approaching-limit summary before register (or skip starting it on managed STEPs). Does **not** fix unready-before-stream-start. |
| `requestHostCompact` / CF `compact_rejected` | Observation only: journal `kind`/`reason`. Softening reject (keep socket) only relabels disconnects. | Observation + legal re-adopt if owner needs `capability_not_ready` vs `blocked` vs timeout before authorizing the wait-point. Not a product close. |

Raising `COMPACT_WAIT_MS` is not a Host Compact patch and does not fix the 80ms unready path. Journaling control frames records a request; it does not produce resume.

F1/F2 (executor isolation + summary metadata) stay a **compatibility** gate for accepting Host’s rewritten root. F3 (`contextWindowTokens` for the custom model) is for later Host-proactive S/P, not required to close confirmed-overflow recovery if the wait-point works.

## Options

Owner call. This page does not authorize any of them.

### Wait-point

Move or split the D2 insert so a slot exists when the custom-model overflow returns.

- **Product-correct:** register before `executeToolStream` (after STEP id is assigned). New Host wait-graph qualification, then packed re-adopt.
- **Narrow:** stop awaiting approaching-limit summary before the slot. Helps `blocked`; leaves first-byte overflow unready.

**Tradeoff:** highest chance the upper goal works for real custom-model overflow (which is fast). Cost: new seam evidence + D2 approval + legal pack/re-adopt. Forbidden to move the insert without that qualification (reopens background / `responseSummaryLaunch`).

### Observation

Authorized preload journal of `requestHostCompact` kind/reason on compact-request, legal re-adopt, one GATE-on look.

**Tradeoff:** splits L5’s 80ms unready vs blocked vs 5s timeout. Does not emit resume-step. Useful only as a pre-auth of the wait-point, not as the product path.

### Accept-fast-canary

Keep the insert; treat L5 as “canary is too fast”; wait for a slow structured overflow after the slot with background unset.

**Tradeoff:** cheapest offline. **Fails the upper goal.** A Bot switched onto a smaller custom W overflows on the first managed request — the same race as the fast canary. Accepting the seam means custom-model continuity through compress stays notProven for the case we actually care about.

## Recommended plan

Versus the current L5 blocker (`slot register after executeToolStream`):

1. Treat that insert timing as the **product** gap, not a canary-only artifact. Do not pick accept-fast-canary as the continuity strategy.
2. Keep Host Compact as the means: official external summarize → Host root rewrite → same custom-model attempt1. Do not route the summarizer onto luna; do not add a grokbox compressor.
3. Optional: observation + one GATE-on if the owner wants `capability_not_ready` vs `blocked` written before authorizing a wait-point. Skip if the owner accepts the offline CF dig (`slot_unready_or_blocked_before_fast_overflow` primary; `compact_wait_expires_while_host_summarize` secondary).
4. Product lever: owner-authorized wait-point change at `compact-register` / `startBackgroundSummary` (prefer register-before-`executeToolStream`). New Host qualification, then legal pack + re-adopt of a grokbox-attested Host. Not this pass.
5. Only after the slot can exist for first-request overflow: one GATE-on test2 journal of structured overflow → compact-request → resume, `harness=box`, canary restored unset. Default-off stays. No hand-clear, no unload unless a later live writer exists.
6. F1/F2 remain on the continuity B track; they do not replace the wait-point. F3 custom-model W is a later Host S/P concern.

No overnight implement lanes. No GATE / unload / tip behavior in the survey that produced this page.

## Forbidden

- Live GATE invent, Host unload, circuit hand-clear, tip behavior-code changes.
- Parallel grokbox summarizer / near-window / product CAP / `store.db` prepend.
- Routing Host dedicated summary onto the managed custom STEP or the same busy executor.
- Using Host input-limit retry or queued summarizeAction as T32 recovery.
- Claiming live compact from overflow_candidate, 5s wait expiry, 37→6 message reshape, or missing control-frame journal.
- Inventing implement tickets or overnight lanes from this plan.

## Freshness

Invalidated by: a D2-approved wait-point / `startBackgroundSummary` change; living Host `runStep` order drift vs `2ede71e2…`; packed preload losing `stateSystemCompactHookOptions()`; a later adjudication that replaces D3/D11; a journaled overflow → compact-request → resume on an attested Host (then T32 live-enable owns the proof, this page stays sequence-only).
