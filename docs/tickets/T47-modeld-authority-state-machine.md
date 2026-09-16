# T47 — Bounded authority waiting in the single STEP program

Status: planned. Milestone M2. Depends on: [T45](T45-modeld-evidence-lifetime.md), [T46](T46-modeld-state-and-durability.md). Spec: [S10.3–S10.6](../roadmap/box-runtime-impl-spec.md#modeld-effect-core).

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

Pending: production state-machine replacement, old path removal, single-effect/terminal proof and fixed-tip review. A standalone state reducer not used by production is not completion.
