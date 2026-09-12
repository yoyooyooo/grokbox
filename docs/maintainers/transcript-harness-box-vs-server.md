# Transcript harness: `box` vs `temporal`

> Publication note: operational identities below are synthetic examples. Private evidence locations and machine execution records are not distributed; historical observations do not qualify a current deployment.

**Role: grokbox implications of the stock App/Host dual ledger.** Not a second Host inbound map. Stock protocol (wire omit, Gateway proxy, desktop coordinator, Mac replica, Cmd-Q) is owned by grok-bot `private interoperability notes (not distributed)` (sibling checkout on this box: `PRIVATE_EVIDENCE`; not vendored here). Working / tray vs pixels stay in [Host / App live projections](host-app-projections.md).

CLI `--harness box|temporal` is implemented on `grokbox agents create/update` and always sends `profile.harness` (box default). Host always-emit is slices `harness-blank` / `harness-summary`. Persist slices (`harness-profile-rpc`, `harness-update-trim`, `harness-agent-write`, `harness-local-write`, `harness-server-write`) keep `box|temporal` on disk through `agents update`, local identity writes, and server identity write-back. Living Host only picks them up after a legal pack + `runtime profile write` + `re-adopt`. Official rollback / Cmd-Q / Mac replica acceptance is [official-rollback-acceptance](official-rollback-acceptance.md). This page does not authorize circuit clears.

## Why grokbox cares

Managed `create-session` wraps `createCursorInferencePromptSession` (`packages/box-runtime/src/internal/host/live-slices.ts`). Host only constructs that factory for **box-hosted** turns. Agents whose Host `profile.json` / roster `harness` is `"temporal"` never hit the patched constructor ([T32 live-enable](t32-live-enable-readiness.md)).

```text
harness=box        → Host runs the turn on box → grokbox intercept can fire
harness=temporal   → Host does not run that turn locally → intercept skipped
```

`SendToUser` still writes the **box** `store.db` when Host actually ran the turn. The App may paint a **Cursor server** replica instead. That is stock dual-SoT, not a missing tool call. Do not treat desktop bubbles as proof the intercept ran, or their absence as proof it did not.

## CLI: `--harness` is sent on create/update

`RosterAttributes.harness` plus `--harness box|temporal`. `createProfile` / `mergedProfile` always include `harness` (`box` if omitted). Other profile fields are preserved. Create sends `harness` at the `createAgent` root (Host RPC accepts it). Update sends `profile.harness`.

Tip persist (after pack + legal re-adopt): `agentProfileFields` keeps `harness`; `updateAgent` trim and `writeAgentProfileFile` pass `box|temporal` through; `writeSandProfileFile` honors incoming `box|temporal` and otherwise keeps the existing binding; `writeServerBackedProfileFile` never lets a server row change an existing file's harness (omit-on-disk is `box`). New files still take the create binding, so `--harness temporal` + `serverId` works. Official Host without these slices still drops update `harness` and can stamp server `temporal` on send. Always-emit roster `box` is not proof createSession wrapped.

## Patching expectation

Keep overflow / managed-session canaries on **`harness=box`** (test2 while it is the heavy canary; never opt-in test1 unless asked). A temporal fork is a **different product path**: no wrapped `createCursorInferencePromptSession`, Gateway transcript reads go through `server-agent-proxy`, desktop coordinator treats the id as `requiredAgents`.

`activity-bridge` restores Gateway composer `currentActivity` on managed box turns. It does **not** hydrate historical bubbles and does **not** copy Host `send-message` into the Cursor server replica. Desktop chrome / sticky-temporal leftover is [composer-working-status](composer-working-status.md). See [host-app-projections](host-app-projections.md).

## Clean rollback vs always-emit harness

Stock Host `buildSummary` emits `harness` **only** when `"temporal"`; box is omitted. Desktop coordinator `db({ raw: undefined, previous })` **keeps** a prior `temporal`. Official Host restart therefore cannot unstick a desktop that already classified a canary as temporal, and it cannot clear Mac `transcript.replicas`.

Always-emit Host slices (`harness-blank`, `harness-summary`) replace omit-box spreads with `harness: … ? "temporal" : "box"`. Coordinator still must not preserve `temporal` across omitted fields (App-side; not this repo). Mac replica wipe remains separate. Living emit still requires those slices on the compile in use; official Host without grokbox slices stays omit-box. See [official-rollback-acceptance](official-rollback-acceptance.md).

Live unload of an attested Host is out of scope for this document. Circuit `uncertain-operation` remains a live-writer blocker elsewhere; do not hand-clear. Machine-local L2 receipts under `PRIVATE_EVIDENCE` observed always-emit on an attested grokbox Host; they are not repo authority.

## Dated observation (not a standing inventory)

2026-09-11 receipts (machine-local, not repo authority): test2 KV had evening canary `send-message` rows while Gateway tail returned a different 8-row server replica after `profile.harness` became `temporal`. App pixels N. Re-check `profile.json` + `listAgents.harness` before citing those counts.
