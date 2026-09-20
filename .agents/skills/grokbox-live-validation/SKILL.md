---
name: grokbox-live-validation
description: Use for a requested grokbox maintainer live/E2E validation window. Not for ordinary operations or a single model-switch check.
---

# Bounded live validation

Start with the selected row in `docs/tickets/LIVE-integration-validation.md` and its section in `docs/maintainers/live-end-to-end.md`. Read linked tickets or operator topics only as needed. These records are claims to check, not proof of current deployment behavior.

The rebuild separates targeted development checks, integrated-candidate E2E, user acceptance/dogfooding, and final visual acceptance. Intermediate builds need not remain usable; do not complete the retired v2 window first or deploy every slice. Native data safety and final recovery properties remain required. The accepted scope and current results come only from LIVE; a low-fidelity functional Web still needs real security and browser proof.

Identify the candidate and select the scenario:

```bash
bun run verify:live-window -- candidate --json
bun run verify:live-window -- plan --scenario <LIVE-ID> --json
```

The controller's source digest and structural checks do not prove implementation completeness, independent review, actual adoption or live behavior. A dirty candidate is planning-only. Probes use the current registered CLI, not planned syntax; command cutover must update probes, Skills and runbook together. Retired scenarios cannot qualify a new result. Record actual CLI/Server/Web/modeld/Host artifacts, targets, authorization, budgets and cleanup scope. Existing explicit authorization remains valid only within its original scope; this plan grants no live mutation.

Observe the same nonce, TURN, STEP and operation after an uncertain result. Do not resend or change Provider to turn unknown into pass. Distinguish configured/captured/emitted/reported model settings, queued input, tool execution, committed checkpoint, delivery and App display.

Use only the selected scenario's required cases. A pass for one model, effort or generation does not cover another. Do not impose a historical six-model matrix or fixed branch name on unrelated work.

Stop the affected mutation path when target identity, ownership, loaded generation, side effects or cleanup become uncertain. Continue authorized readback and reconciliation. Preserve the first failure and original identities; fixture events cannot replace native observations.

Validate a small redacted receipt:

```bash
bun run verify:live-window -- receipt --file <redacted-receipt.json> --json
```

The receipt parser is in `scripts/live-validation.mjs`. Its schema acceptance does not establish the scenario's oracle. Record bounded observations and what remains unverified, without credentials, raw transcripts or provider bodies.

Update the dated report and the selected LIVE row's current result/evidence link. Do not create a second status ledger. Revalidate affected results after changes to candidate, loaded artifacts, native bytes, configuration or dependencies.
