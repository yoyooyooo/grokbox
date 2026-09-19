---
name: grokbox-live-validation
description: Use when developing or maintaining grokbox and the user asks for a full end-to-end, live-window, or integration validation against docs/tickets/LIVE-integration-validation.md. Do not use for ordinary user operations, a single model-switch check, or product CLI design.
metadata:
  short-description: Run bounded grokbox live validation
---

# grokbox live validation

Use this skill for the maintainer-side E2E workflow in the grokbox repository. The goal is a bounded, reviewable validation window with a fixed candidate, direct observations, safe stopping, and a dated receipt. The product's LIVE index remains the only current status authority.

## Read the current homes

Read these in order:

1. `docs/tickets/LIVE-integration-validation.md` for current scenario IDs, gates, result, blockers, and evidence links.
2. `docs/maintainers/live-end-to-end.md` for the selected journey's actions, oracles, budgets, recovery and cleanup.
3. The source ticket linked by the selected LIVE row for implementation and offline limits.
4. `skills/grokbox/validation.md` only when the selected journey includes the six model/effort cells.

Do not copy the current result into a new checklist. Do not create a second readiness table.

## Freeze before touching live state

Run the repository controller from the fixed, merged `feat/box-runtime-v2` candidate:

```bash
bun run verify:live-window -- candidate --json
```

Require a clean worktree, stable source digest, passing LIVE documentation gate, and an exact source commit before a real window. `--allow-dirty` is allowed only to inspect a planning slice. A candidate check does not prove that Host, modeld, App, Provider, Webhook, or native state has adopted it.

Select only explicit scenarios:

```bash
bun run verify:live-window -- plan --scenario <LIVE-ID> --json
```

Record the window ID, operator, source and artifact hashes, actual loaded identities, authorization, object roles, budget, recovery path, and cleanup scope before a mutating step. A script result never grants restart, model spend, Bot creation, Routine enablement, deletion, publication, or provider access.

## Choose the smallest honest observation surface

Use the smallest surface that can answer the current question:

| Question | Surface |
| --- | --- |
| Is the repository candidate and LIVE index internally consistent? | `candidate` |
| What does the current box report without mutation? | `probe` with explicit read-only probe names |
| Did a real provider/model/tool/compact/App path happen? | The exact CLI, native Host/App or provider observation in the runbook |
| Can the window evidence be safely routed back? | `receipt` plus the dated report |

The controller's probes are bounded and redacted:

```bash
bun run verify:live-window -- probe --probe doctor --probe roster --probe models --probe runtime --json
```

A probe pass supports only the command, dependency reality, and state it directly observed. It does not prove a reply, emitted effort, tool execution, compact checkpoint, App rendering, Webhook delivery, restart adoption, or cleanup.

## Execute and observe one scenario at a time

Follow the selected runbook section. Keep the exact object IDs, nonce, TURN, STEP, operation, work, attempt, generation, and revision together. Use a fresh bounded input only when the runbook calls for a new operation. If a send is queued, observe the same nonce; never resend to make progress visible.

For the model matrix, keep all six cells separate. Record requested, captured, emitted, and provider-reported effort independently. A high cell does not cover xhigh. A successful Provider does not cover another Provider. A title paint or accepted receipt is not a completed run.

For compact and recovery, distinguish no-op, pending, failed summary, committed checkpoint, next-input continuation, and post-restart native readback. A model repeating a fact is not checkpoint evidence.

For Webhook and Routine paths, keep preflight, binding, activation, one explicit send, actual receipt, automatic delivery, requalification, and disable as separate observations. HTTP 200 alone is not user receipt. Do not synthesize native events in SQLite or call an unimplemented invoke command.

## Stop and preserve uncertainty

Stop the affected lane as soon as any of these occurs:

- ownership, loaded generation, source/artifact identity, nonce, operation or cleanup state is unknown;
- a write may have happened twice or a non-test object is involved;
- an unexpected tool side effect, credential, private path, or raw provider payload appears;
- the budget is exhausted or the observation cannot distinguish queued, delivered, failed and unknown;
- a dependency changed after the candidate was frozen.

Preserve the first wrong boundary and all already-produced IDs. Do not change nonce, Provider, endpoint, or model to turn unknown into pass. Continue only with authorized readback, reconciliation, or cleanup. Put code defects in the source ticket, fixed-window facts in a dated report, and the current blocked result and next action in LIVE.

## Validate and route the receipt

Create a small redacted JSON receipt for one stable LIVE ID and check it before editing LIVE:

```bash
bun run verify:live-window -- receipt --file <redacted-receipt.json> --json
```

The receipt needs `version: 1`, `kind: "grokbox-live-receipt"`, `windowId`, one known `scenario`, the exact `candidate.sourceCommit`, bounded `steps` with observations and report/private references, `cleanup.state`, and `notProven`. Do not include secrets, absolute paths, raw transcripts, or provider dumps.

`indexEligible: yes` means only that the receipt is structurally complete, every listed step passed, and cleanup is complete. Compare it with every LIVE oracle and the direct observations before changing the index. A code fix, an offline green suite, or a receipt check never changes a LIVE row to `passed` by itself.

After the window, update the dated report first, then replace the selected LIVE row's current result and one evidence link. Keep historical failure reports intact. If the candidate, loaded artifact, native version, config revision, or dependency changed, mark only affected rows `needs-revalidation`.
