# Adjudication — 2026-09-08 Host seam normalization and roadmap

> Publication note: operational identities below are synthetic examples. Private evidence locations and machine execution records are not distributed; historical observations do not qualify a current deployment.

Owner decisions for the box-runtime execution chain. Binding until a later dated adjudication supersedes them. The [implementation plan](../roadmap/box-runtime-plan.md) remains the single forward-looking Current Home; this record preserves the decisions and their scope.

## Context

- Baseline: `feat/box-runtime-v2` at `pre-publication-revision`; runtime source includes `pre-publication-revision`. Tool-role continuation is fixed, while user-contained tool-result fidelity, implicit truncation, first-STEP binding and Host stream consumption still need work.
- The official Host continues to change context, root/session, compact and tool-loop hot paths. grokbox must preserve the Host product contract in both directions while containing version-specific adaptation.
- Implementation effort is evaluated on three axes: **D — debuggability/observability**, **S — live STEP stability/safety**, **H — maintainability under Host harness churn**. Necessary execution boundaries are not over-design; speculative artifact/service families are not prerequisites.
- This adjudication replaces the earlier plan's absolute two-slice ceiling, projection-file-first design, early multi-writer CAS requirement and raw-fd-first ordering. It does not claim the corresponding runtime changes are implemented.

## Decisions

### D1 — Bidirectional normalization

**Normalize both directions through explicit, necessary codec boundaries.**

Host → Provider preserves Host-selected context, including user-contained and mixed text/tool-result content. No silent truncation, keyword-based removal or invented history selection. Unsupported input fails visibly before provider effect.

Provider → Host reshapes output into the original PromptSession/session/executor and `fullStream` contract: synchronous handle, independent completion/usage, modelId alignment, message/state shape, tool correlation and coherent terminal/response. The Host continues to own session/store updates, tool execution and SendToUser. A final string or a second session store is not a substitute. Keep the codec abstractions required to preserve these semantics.

### D2 — Evidence-bounded Host patch surface

**Prefer the thin current two-slice leaf; allow extra Host patches when stability/capability gains clearly outweigh added coupling.**

For an extension, identify the missing capability, exact target/profile, affected consumers, coupling cost, failure/exit path and executable proof of bidirectional compatibility and official passthrough. Retain exact source/anchor/transformed/compile checks and explicit approval. Do not spread Host implementation details into the kernel or rebuild Host core methods.

Current transform/authoring code still validates two slices. Supporting an approved extension requires the corresponding schema/validator/tests; this decision does not authorize bypassing existing checks or applying an unreviewed patch.

### D3 — Host context and Memory ownership

**Accept Host compact and preserve its selected `getExecutor` context.**

Do not prepend `store.db` history or counteract compact with a grokbox near-window/summary system. Long-term facts belong to Host-owned Memory distillation. `GROKBOX_LIVE_PROMPT_*_CAP` remains debug-only and unset in live. Preserve CCS-safe text, SendToUser bubbles and tool stdout folding without restoring the known-rejected raw Responses `role=tool` path.

### D4 — Fidelity-first Phase 0

**Prioritize A3fu tool-result fidelity together with A7 removal of implicit truncation and keyword drops.**

Use actual Chat/Responses encoded-request fixtures with user-contained/mixed tool results, long output tails and no extra Human turn. Close A6's default raw Host fd separately, preferably by restoring ignore; do not gate the fidelity work or its next kernel slice on it. Keep T12 renewer delivery and do not turn this fix into a new diagnostic product or automatic cleanup of live files/fds.

### D5 — Thin Host-visible selection

**Use bounded fields on the existing managed session ABI first, not a new projection-file family.**

Carry the minimal agent/TURN/modelId/selectionRevision through session construction/local state and STEP submission so `getModelId()`, admitted target and returned identity align. Reuse bounded config reading and pure selection calculation. modeld validates canonical opt-in and expected selection before credential/provider effect; no service `main` fallback and no post-spend mismatch as the primary fence.

Keep the accepted binding through the TURN, or refuse after expiry/restart; never silently re-pin or change account/endpoint. Separate selection identity from global config CAS identity, without creating a revision ontology. Provider credentials and activation authority stay outside the Host.

### D6 — Simple anti-overwrite at the second writer

**Keep the current configuration path simple; add shared CAS protection when a real second writer appears.**

Maintain one narrow schema-checked read/change/save entry and basic atomic publication. Do not block RouteBinding on a general transaction service, projection publisher or multi-file revision system.

Before WebUI writes—or earlier if another actual concurrent writer is introduced—put a short lock, canonical reread, expected config revision check, unique staging/publication and source receipt in that same CLI/API entry. Do not claim single-writer code is concurrency-safe, and do not implement a UI-only lock. Conflict preserves intent and requires reread rather than silent overwrite. This timing does not defer the first-STEP selection fence.

### D7 — True streaming in Phase 1

**Complete A8 in Phase 1 for Providers that support streaming.**

The official Host is stream-oriented for Transcript/SendToUser consumption. Finish the real `fullStream` consumer and provider-to-Host normalization; streaming is not merely a TTFT polish item to remove from the core chain. Bound bytes/parts/backpressure, keep completion independent of UI subscription and avoid duplicating full output in wire terminal frames.

A batch-only Provider may expose an explicitly buffered capability through the same Host-shaped handle; never claim native streaming for it. EOF without a terminal is not success, and absent usage is not fixture accounting. RouteBinding may land as an earlier slice without removing this Phase 1 obligation.

### D8 — Effect root and resource ownership

**Close A9 acquire/finalizer together with the long-lived Effect root that acquires the resources.**

This is wanted, low-cost boundary firmness: paired acquire/release, partial-acquire cleanup, cancellation and startup/stop symmetry. Keep one root per grokbox process/command and attach request/turn resources to the correct lifetime. Do not replace the work with a Promise wrapper, or require an Effect Service for every pure helper/file lock.

Effect remains the default for heavy side effects; Host/preload remains Effect-free and SDK-free. Timeout/cancellation preserves unknown external outcomes. The independent guardian and current J13 Host-append/watchdog-compactor placement remain unchanged.

### D9 — Early minimal T13 facets

**Define and deliver the minimal facets early in Phase 1, not only as a late writable-UI dependency.**

Separate bridge/activation evidence, modeld readiness, controller liveness, mutation permission/inhibit, operation recovery and Host delivery observation. Valid current coverage may coexist with a stored open circuit; show the inhibit and keep unobserved liveness unknown. Actual pending/invalid operation state remains recovery-required/unknown.

Do not auto-close the circuit. Legacy `watchdog.state=degraded` may remain while the explicit facets clarify its meaning; renaming and deep traces are not prerequisites. Use trusted local request correlation, never provider body fields or timestamp guesses.

### D10 — One ModelBackend port before new backends

**Establish Effect DI and the ModelBackend port in Phase 1 with current AI SDK + Fake implementations.**

Keep one admission/lifecycle program and substitute capabilities, not business policy. Pi RPC and Cursor SDK are later Phase 3 candidates. Qualify their exact protocol/package, explicit snapshot handling, auth/state isolation, stream/cancel and terminal behavior before enabling them.

No backend may introduce another Agent loop, tool execution, hidden root/history/Memory, auto-compact or implicit retry/failover. If a candidate cannot supply the inference-only contract, defer/refuse it rather than relaxing Host ownership.

### D11 — Confirmed-overflow Host recovery

**T14b only recovers a confirmed context overflow through Host's own compact capability.**

A log `overflowCandidate` or generic `model_error` is not authority. Require a typed current-attempt outcome, qualified non-conflicting provider evidence, trusted correlation, terminal prior attempt and proof that no executable tools/user delivery were released. Auth, rate limit, generic 400/500, HTTP payload limits, timeout/disconnect and unknown outcomes do not trigger compact.

Use the same TURN/binding, obtain a new Host-selected snapshot, revalidate and allow at most one deduplicated recovery attempt. Missing capability, no improvement, cancellation or failed retry ends visibly. Do not invent Host IDs, clear the ledger or add a parallel summarizer. T14b depends on its own seam/binding/lifecycle/evidence gates, **not completion of all T16 adapters**.

### D12 — Ablation-guided scope

**Keep what materially protects D/S/H; defer structure or proof ceremony that does not move those axes or the current product exit.**

Retain bidirectional normalization, pre-effect binding, true Host stream consumption, resource finalization and minimal honest observations even when they require real abstraction. Defer projection-file families, complex CAS before a second writer, universal Service graphs and full retirement/trace/audit infrastructure without a demonstrated need.

Expose capacity and refuse safely now; require retirement/soak evidence before claiming sustained operation beyond the supported limit, not before the first binding slice. Keep later WebUI/adapters/compact work behind its real prerequisites rather than treating every roadmap item as a single blocking launch.

## Explicit non-decisions

- No runtime implementation, specific extra patch/profile approval, live adopt/re-adopt, canary or provider-spend authorization is granted by this document. No test1 opt-in or live file/fd cleanup.
- No change to Host ownership of Agent loop, tools, root/compact materialization, session/store, Memory/Transcript, SendToUser, official renewal or Gateway publication.
- No change to the J13 placement, independent guardian, local-only runtime boundary or declared Bun/Effect pins. The applicable J13, G1 authorization and Bun constraints in the [2026-09-07 adjudication](2026-09-07-offline-live-adjudication.md) remain in force.
- No new configuration SoT, authoritative SQLite, hidden command outbox, automatic circuit close or assumption that a Pi/Cursor backend has already qualified.
- The dated roadmap stub remains a pointer to the implementation plan. This adjudication is a decision record, not a parallel execution roadmap or proof that the plan has shipped.
