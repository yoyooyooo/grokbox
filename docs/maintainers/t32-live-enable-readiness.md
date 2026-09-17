# T32 live-enable readiness

This public page defines qualification boundaries, not a machine execution diary. Private operational records, deployment identifiers, agent state, and local evidence locations are not distributed.

## Current target: local context maintenance

[Spec S12](../roadmap/box-runtime-impl-spec.md#context-maintenance) and [CTX-01–CTX-04](../tickets/README.md#context-maintenance) now own default-auto local budgets, preflight for an already-stuck session's next input, bounded independent summarization and durable continuation. These are planned obligations, not completed or enabled features. Existing T32/T35 code and prior canaries prove only their scoped recovery/lifetime subsets.

A release cannot be qualified merely by setting the old HostCompact environment variable or restarting. It must show the exact new policy/config schema, matched Host/modeld protocol and capability, pre-main-request compaction without a Provider overflow prerequisite, preservation of the new input, original failed STEP/tool identities and checkpoint/readback. The ordinary environment gate retires with the implementation; fault injection remains separate and disabled in normal use. Offline/native-copy gaps stay in CTX; actual runtime/App/restart gates use the shared LIVE backlog.

## Independent release gates

Source tests and typechecking establish only the tested implementation. Packed CLI/preload tests establish only the built artifacts and their owned fixtures. Neither establishes the currently loaded native Host, live provider behavior, original App routing, native checkpoint durability, or a supported persistent service installation.

Native release must independently establish current source/profile compatibility, ownership and identity agreement, preservation of existing agent state, official/custom model roundtrip, native context and checkpoint continuity, and original-App acceptance. Unknown or conflicting evidence remains a blocker.

## Operational boundary

An earlier canary or fault-injection approval is not standing rollout authorization. Do not restart or re-adopt a live Host, signal modeld, rewrite credentials, clear a circuit, migrate an agent, or replay a provider request solely because source tests pass. Use explicit scoped confirmation and the existing lifecycle and recovery contracts.

## Public authority

Current obligations live in the product contract, architecture, runtime implementation spec, T32 and T37–T41 tickets, and the maintainer acceptance pages. This page makes no production-ready or current-deployment claim.
