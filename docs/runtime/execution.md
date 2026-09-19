# Model execution and authority

This is the current home for the managed STEP program, authority/source lifetimes, model selection and stream boundaries. [Architecture](../architecture.md) owns composition; [context](context.md) owns compaction; [Host compatibility](host-compatibility.md) owns deployment. Source and tests determine the implemented behavior. Review gaps belong to [modeld tickets](../tickets/README.md#modeld-effect-core), and current native/live results only to [LIVE](../tickets/LIVE-integration-validation.md).

## Source entry points

| Concern | Owner |
| --- | --- |
| STEP, durable claims and binding | [step-program](../../packages/runtime-kernel/src/internal/inference/step-program.ts), [execution-history](../../packages/runtime-kernel/src/internal/inference/execution-history.ts), [route-binding](../../packages/runtime-kernel/src/internal/inference/route-binding.ts) |
| Authority decisions and budgets | [authority-gate](../../packages/runtime-kernel/src/internal/inference/authority-gate.ts), [policy](../../packages/runtime-kernel/src/internal/contract/authority-policy.ts) |
| Shared remote source and local witness | [ownership coordinator](../../packages/box-runtime/src/internal/io/ownership-coordinator.node.ts), [admission adapter](../../packages/box-runtime/src/internal/io/ownership-admission.node.ts) |
| Service and protocol | [modeld root](../../packages/box-runtime/src/internal/roots/modeld.runtime.ts), [server](../../packages/box-runtime/src/internal/modeld/server.node.ts), [wire](../../packages/runtime-kernel/src/internal/contract/wire.ts) |
| Stream/tool validation | [stream state](../../packages/runtime-kernel/src/internal/inference/stream-state.ts), Box backend/Host adapters |
| Models and effort | [configuration](../configuration.md), [reasoning ticket](../tickets/FEAT-model-reasoning-policy.md) |

Precise versions, counters and limits live in these sources. Earlier wire/phase values in fixed reports are not current defaults.

## Authority and identity

Server registration determines whether a Bot belongs to Box execution. It does not own native conversation content or independently grant all tool permissions. Local allowed/bound booleans are insufficient to replace supplemental Server evidence. There is one execution path, not selectable native-versus-polling authorization engines.

OwnershipEvidence is an observation; an in-process AuthorityPermit is a checkpoint-scoped decision; AuthorityObservation is diagnostic output. Callers cannot deserialize a permit from wire/config/journal/SQLite. No Server lease or revision is invented when upstream exposes none. confirmed_box is not production approval.

Cache only the qualified remote evidence portion. Each prospective permit still checks current local scope, pause/migration, binding and Host generation. A cached combined snapshot is not current native state. Missing native local-witness capability refuses the optimization; no generic RPC or guessed ready state substitutes for it.

Hard invalidation is monotonic for the original binding. A later box snapshot cannot revive a TURN that observed revocation, cancellation or generation loss. A normal future model-config change is different from revoking execution authority.

## One STEP program

The same production program is used by live adapters and fake capability layers:

1. Decode a bounded frame and validate wire/Host/service identity. Establish one ingress deadline.
2. Durably claim the STEP and corresponding TURN metadata before model effects. Unknown acknowledgement does not fall back to an in-memory claim. Duplicate identity never redispatches.
3. Check deployment/local fences; consume qualified evidence or join bounded authority waiting.
4. Capture model, capability, binding and credential fingerprint. Prepare may suspend but is not permission to call the provider.
5. Recheck actual dispatch fences after waiting/prepare/auth; consume the remaining deadline, not a renewed request budget.
6. Run ModelBackend. Qualified provider recovery and confirmed-overflow remain bounded subprograms of this same claim, not new TURNs.
7. Validate complete tool material and terminal; check authority at release/consumption boundaries. Waiting after inference buffers only within limits and does not infer again.
8. Persist settlement and emit at most one terminal. Release waiter/stream/resources without rewriting already-produced effects.

Tool release, Host execution, checkpoint and SendToUser delivery are distinct facts. A stream cannot fabricate successful completion when durable settlement is unknown.

## Shared source, waiter and clocks

Source operations belong to the service/operation Scope; waiters belong to individual STEP or diagnostic scopes. Each source has fixed scope, target coverage, generation, start/deadline and bounded outcome. Later waiters do not extend it; one cancelled waiter does not cancel another valid demand. Non-cooperative sources keep occupying their resource slot until actually settled, preventing unlimited orphan replacements.

Demand is coalesced only within compatible scope/target coverage. Queue, active source count, retries and buffers are bounded. Execution demand has explicit priority over refresh/observation with fairness tests; no per-token polling. With no demand, execution refresh stops.

Elapsed budgets use an injected process-local monotonic clock, not wall-clock nanos. Across processes use scoped relative durations, not subtraction of unrelated monotonic ticks. Evidence retains its original source age; response arrival, refresh failure and cache read do not renew it. Unknown/future age and wall-clock jumps never create negative-age permission.

The canonical strict-observation policy permits qualified same-STEP reuse under its original-age ceiling; a new STEP has the narrower cross-STEP cache window. The evidenceOwner is in-process claim identity, not a wire/config/log key or second payload cache. Current constants are in [authority-policy](../../packages/runtime-kernel/src/internal/contract/authority-policy.ts); changing them is an explicit policy/qualification change, not latency-dependent auto-relaxation.

Same-STEP reuse lowers remote sampling frequency inside the allowed window. It does not prove instantaneous revocation or upstream snapshot consistency. Every checkpoint still checks local fences; original evidence expiry, scope change or source retirement requires fresh evidence within the remaining wait budget.

source_deadline/cancelled/cancelled_unknown/scope_invalidated differ from waiter_deadline/caller_cancelled. Preserve read/waiter identity, original age, remaining budget and actual settled/unknown outcome. An RPC cancellation code alone does not identify who cancelled it.

## Service, storage and cancellation

One modeld acquisition program distinguishes owned from borrowed resources. Listener/client/STEP and service/source relationships are explicit; TURN lifetime is not owned by the first STEP. Stop refuses new work, then boundedly interrupts/settles accepted work before closing storage/listener. Cleanup gaps are not success.

ExecutionHistory is the unique durable execution writer. Per-identity synchronization and short global capacity/index sections must not hold an unbounded global lock across unrelated Bot IO. Moving IO outside a lock still requires identity/revision revalidation before commit. Front-door pressure checks are bounded; reclamation belongs to the service maintenance path.

waiter ended, Fiber interrupted, signal sent, source settled and remote outcome known are separate observations. Effect Scope is neither rollback nor a cross-file transaction. Keep independent crash-recovery/guardian evidence and do not detach uncooperative work to fake resource closure.

## Model selection and reasoning

Only a per-Bot assignment opts that Bot into managed execution. main/default is not a hidden fallback for unassigned Bots. models use/reset changes future selection; the current TURN and its recovery retain the captured model, capability, selection revision and credential fingerprint. Reset is a scoped exit to the native official session, not a harness migration or global deactivation.

An unavailable managed bridge/config/qualification fails visibly; it does not silently switch to official or another provider. Unassigned official passthrough remains native and should not incur managed source/provider calls.

Reasoning acceptance vectors retain the original stable labels:

| Vector | Required behavior |
| --- | --- |
| R01 | Structured assignment; explicit migration/write; unknown fields rejected; no derived model-catalog variants or implicit root migration |
| R02 | Effort only from the exact endpoint/API/model capability; omission/default clears; none requires support; no inferred level from Pi boolean/numeric budget |
| R03 | Capability/policy enters selection revision; old TURN and claim identity remain immutable; unrelated Bot edits remain isolated |
| R04 | Final encoded HTTP model/API/effort agrees with the frozen choice, preserving other settings such as parallelToolCalls; conflict rejects before dispatch |
| R05 | configured/captured/emitted/providerReported are separate; missing provider report is unknown; reasoningTokens is an optional output subset, not added twice |
| R06 | Matched wire/profile/consumer and Node packed qualification; old peer diagnostics do not authorize new execution; provider/native/App results remain separate |

## Content, stream and recovery

Preserve native system/history/metadata, mixed-content order and tool identity. The adapter does not silently prune, reorder by type, fabricate tool results or rebuild the prompt from transcript replicas. Unsupported images/protocols fail before provider effects. Cache misses may affect performance, not correctness.

ModelBackend streams canonical events but does not execute tools. `validated-batch` holds the entire tool batch until declared names, IDs, complete arguments and successful terminal validate; release in original order. Multiple calls are not intrinsically invalid and must not be dropped/split into new model STEPs. Error/cancel before release produces no released tool material; after effects have occurred, report them honestly. Host still owns permissions, approval, actual parallelism, result acceptance and checkpoint.

Default provider recovery is off. Explicit pre-output-http recovery is only for the recognized transient HTTP classes before nonempty text/reasoning/tool material has been released, within time and extra-request budgets. Each attempt is durably declared; recheck authority, original selection and credential. Unknown network outcome, incomplete stream, auth/quota, bad tool material, already-output work and service restart do not authorize replay, provider switching or sendPrompt retry.

Confirmed-overflow recovery uses the shared [context mechanism](context.md), requires its structured cause and zero-release conditions, and retains the one-extra-main-request limit. Ordinary errors do not become overflow. Main empty output fails; a complete, qualified memory-extraction/episode request with matching parent/model and no tools may legitimately finish with no text. Record auxiliary no-op separately, never invent NONE text or persist reasoning as Memory.

## Observation and proof

Record causal state transitions, not guessed explanations: read/waiter/evidence/policy identity alongside Agent/TURN/STEP/Host/service identity; queue/source/backoff/local-fence/storage times; backend attempts, canonical events, released tools and delivery separately. IDs belong in bounded traces, finite enums in metric labels. Diagnostic failures do not alter execution authority; restored SQLite green state cannot permit a STEP.

`bun run verify:modeld-core -- <case>` uses finite source-bound suites; unknown/empty cases fail. Tests cover slow/expired sources, late waiters, cancellation sharing, uncooperative operations, generation change/ABA, prepare/auth races, infer-then-wait, tool approval, claim/settlement unknown, crash/restart, fairness, observer failure and resource closure. No performance SLA is inferred without a fixed comparable load.

The remaining native/tool/App qualification and independent review stay in [modeld/T49](../tickets/T49-modeld-qualification-and-release.md), [modeld/T50](../tickets/T50-modeld-review-residue.md) and [AUTH](../tickets/AUTH-ownership-evidence-availability.md). Fixed historical gaps do not reopen replaced programs, and passing a source suite never changes a LIVE row by itself.
