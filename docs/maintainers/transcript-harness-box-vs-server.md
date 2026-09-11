# Transcript harness: `box` vs `temporal`

> Publication note: operational identities below are synthetic examples. Private evidence locations and machine execution records are not distributed; historical observations do not qualify a current deployment.

**Role: grokbox implications of the stock App/Host dual ledger.** Not a second Host inbound map. Stock protocol (wire omit, Gateway proxy, desktop coordinator, Mac replica, Cmd-Q) is owned by grok-bot `private interoperability notes (not distributed)` (sibling checkout on this box: `PRIVATE_EVIDENCE`; not vendored here). Working / tray vs pixels stay in [Host / App live projections](host-app-projections.md).

This page does not implement Host or App patches. It does not authorize profile flips, re-adopt, or circuit clears.

## Why grokbox cares

Managed `create-session` wraps `createCursorInferencePromptSession` (`packages/box-runtime/src/internal/host/live-slices.ts`). Host only constructs that factory for **box-hosted** turns. Agents whose Host `profile.json` / roster `harness` is `"temporal"` never hit the patched constructor ([T32 live-enable](t32-live-enable-readiness.md)).

```text
harness=box        → Host runs the turn on box → grokbox intercept can fire
harness=temporal   → Host does not run that turn locally → intercept skipped
```

`SendToUser` still writes the **box** `store.db` when Host actually ran the turn. The App may paint a **Cursor server** replica instead. That is stock dual-SoT, not a missing tool call. Do not treat desktop bubbles as proof the intercept ran, or their absence as proof it did not.

## CLI gap: `grokbox agents update` cannot persist `harness`

`packages/cli/src/commands/agents.ts` `runAgentsUpdate` → Gateway `updateAgent` / notify / hidden only.

`packages/cli/src/commands/management.ts`:

- `RosterAttributes` has `name`, `description`, `title`, avatar, `notify`, `hidden`. **No `harness`.**
- `registry.ts` `agents update` flags match that set. No `--harness`.

Host `profile.json` is the durable field. `grokbox agents update` does not write it. Do not assume a roster PATCH kept a canary on box.

## Patching expectation

Keep overflow / managed-session canaries on **`harness=box`** (test2 while it is the heavy canary; never opt-in test1 unless asked). A temporal fork is a **different product path**: no wrapped `createCursorInferencePromptSession`, Gateway transcript reads go through `server-agent-proxy`, desktop coordinator treats the id as `requiredAgents`.

`activity-bridge` restores composer-above Working. It does **not** hydrate historical bubbles and does **not** copy Host `send-message` into the Cursor server replica. See [host-app-projections](host-app-projections.md).

## Clean rollback vs always-emit harness

Stock Host `buildSummary` emits `harness` **only** when `"temporal"`; box is omitted. Desktop coordinator `db({ raw: undefined, previous })` **keeps** a prior `temporal`. Official Host restart therefore cannot unstick a desktop that already classified a canary as temporal, and it cannot clear Mac `transcript.replicas`.

Future unpatch contract (pointer only; **not implemented here**):

1. Host always emits `harness: "box" | "temporal"`.
2. Coordinator must not preserve `temporal` across omitted fields; must not promote unmarked box rows from `onAgentState`.
3. That contract still does not delete Mac `sand-client-persistence`. Cmd-Q recycles coordinator maps; wiping the replica dir is a separate Mac step. Host restart is not backfill.

Live re-adopt / harness profile edits are out of scope for this document. Circuit `uncertain-operation` remains a live-writer blocker elsewhere; do not hand-clear.

## Dated observation (not a standing inventory)

2026-09-11 receipts (machine-local, not repo authority): test2 KV had evening canary `send-message` rows while Gateway tail returned a different 8-row server replica after `profile.harness` became `temporal`. App pixels N. Re-check `profile.json` + `listAgents.harness` before citing those counts.
