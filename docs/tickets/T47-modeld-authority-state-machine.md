# T47 — Bounded authority waiting in the single STEP program

Status: core implementation and offline chains verified; outer-timeout integration review and final qualification remain open in T49. Milestone M2. Depends on: [T45](T45-modeld-evidence-lifetime.md), [T46](T46-modeld-state-and-durability.md). Spec: [S10.3–S10.6](../roadmap/box-runtime-impl-spec.md#modeld-effect-core).

## Goal

Make authority acquisition a bounded phase of an already claimed STEP, not an immediate terminal/poison reaction to every transient read error. Preserve all model, credential, tool, cancellation and replay boundaries. Authority recovery never means provider inference replay.

## Module / files

- `runtime-kernel/src/internal/inference/authority-gate.ts`: only checkpoint/decision/wait program.
- `runtime-kernel/src/internal/contract/authority-policy.ts`, `ports.ts`: finite outcomes and one remaining-budget policy.
- `runtime-kernel/src/internal/inference/step-program.ts`, `route-binding.ts`, `step-ledger.ts`: transitions and monotonic invalidation.
- `box-runtime/src/internal/modeld/server.node.ts`, wire/Host client: owned STEP progress and necessary protocol version.
- Host validated-batch/consumer qualification tests at the existing output boundary.

## Required behavior

Claim -> waiting -> authorized -> preparing/verifying -> dispatch -> streaming -> terminal, with revalidation at actual tool-release/success boundaries. A transient source failure may wait within the same live STEP, original input, selection and service epoch; no intermediate terminal. Explicit identity change, native pause, generation loss or original credential mismatch fences immediately. One generic `tapError` may no longer classify every gap as permanent revocation.

All waits consume the same STEP wall deadline and bounded cumulative authority allowance; per-layer timeouts cannot reset it. Reuse a still-qualified evidence object at multiple checks while verifying local fences. Prepare or approval can suspend: do not treat an earlier grant as permanent. An issued terminal/closed TURN/retired service cannot revive; explicit invalidation is monotonic even if a later read again says box.

When inference has already begun, preserve actual attempts and partial-output facts. Waiting for evidence cannot call infer again. Results can wait only within existing byte/time budgets; no unbounded spooling. Host tools-released and native tools-executed are separate facts. Do not implement a second tool executor to bridge the gap.

## Acceptance

```bash
bun run typecheck
bun run verify:modeld-core -- authority
```

Test a transient failure followed by valid evidence in one STEP: exactly one claim/terminal/provider call. Test budget exhaustion before dispatch: zero provider/tool-release effects. Test failure after provider output: no reinference, faithful attempt count, bounded held output. Test cancellation at each wait/prepare/auth/release point, deadline accumulation, explicit revoke and box-return, late old-generation evidence, same-STEP duplicate while waiting, old TURN after terminal, source recovery on a new STEP only when its original binding rules permit it.

Exercise real Unix and Host handle consumers, including accepted-before/after-progress ordering. If pre-accepted authority frames are introduced, bump wire explicitly and qualify old/new refusal; no silent old-peer execution. Provider recovery remains an independently authorized existing mechanism. Re-run ownership admission, stream observation, compact/recovery fences and released-tool contracts.

## Forbidden / non-goals

No clearing poison to replay a failed request, new user message, new STEP hidden retry, fallback model, globally extended deadlines, synthetic tokens/messages, unlimited waiting or weakening current defaults without T49's policy decision. No cross-restart workflow resume or claims of atomic Server/Host authorization.

## Exit evidence

Production `runStep` uses the single `authority-gate.ts` program and registers its cancel/budget owners at durable claim time. The coordinator alone retries eligible reads (at most two attempts per check, with a cumulative per-STEP retry and waiting allowance); the gate does not invoke inference. `open/revoked/closed` replaces generic poison. Exhausted transient observations close the STEP/TURN without claiming observed revocation; explicitly observed identity changes revoke it. Neither closed state is replayable.

The process-local permit is frozen and registered to its exact live STEP, service incarnation and memory owner. A copied DTO, a settled STEP, another runtime or an expired permit cannot authorize use. Dispatch verifies credentials again after a potentially slow ownership wait, then validates that same permit locally instead of alternating remote/auth reads without a bound.

Wire v6 carries finite ordered authority control frames before or after binding acknowledgement. Controls cannot replace accepted/terminal, create a model token, renew deadlines or grant execution. V3–V5 execution is rejected; V4/V5 identity probes remain explicitly read-only. A duplicate claim still awaiting its binding receives a refusal rather than an invalid empty-binding accepted frame.

Executable proofs are `authority-gate.test.ts`, `authority-wait-unix.test.ts`, `authority-wire.test.ts`, the coordinator delay/cancellation tests and existing binding/compact/recovery suites. They cover pre-dispatch and post-inference recovery with one provider effect, cumulative deadlines, immediate admission cancellation, exact duplicate absorption, credential rotation, permit expiry, old-peer refusal and one terminal. Final aggregate results and remaining native tool-consumption/live boundaries are recorded in T49; synthetic Unix tests do not qualify the original App or an actual Server lease.

Remaining integration boundary: `server.node.ts` still retains the pre-existing outer admission cap in addition to the kernel's cumulative authority allowance. Both remain finite and fail closed, but a full-budget race may report the outer timeout rather than the more specific gate/source outcome. This is not treated as a proved causal-timeout closure or silently removed; T49 must qualify that boundary before signing the complete execution-core release.
