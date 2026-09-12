# Official Host rollback acceptance

> Publication note: operational identities below are synthetic examples. Private evidence locations and machine execution records are not distributed; historical observations do not qualify a current deployment.

**Role: maintainer checklist + evidence map for a future clean return to official Host.** Not a live unload. Not a second harness or Working map. Do not run this pass against a living grokbox-attested Host just to exercise rollback.

Stock App/Host dual ledger (omit-box, Gateway proxy, coordinator sticky-temporal, Mac replica, Cmd-Q) is owned by grok-bot `private interoperability notes (not distributed)` (sibling checkout on this box: `PRIVATE_EVIDENCE`; not vendored). Grokbox harness implications stay in [Transcript harness: box vs temporal](transcript-harness-box-vs-server.md). Working / tray stay in [Host / App live projections](host-app-projections.md).

This page does not authorize circuit clears, `inject` / `heal` / `kill`, hand-TERM, or edits to box `store.db`.

## Freshness

Invalidate when any of these change: `runtime deactivate` / `re-adopt` / watchdog live-writer wiring; `inspectControllerFacts` `desired-disabled`; Host `buildSummary` omit-box vs always-emit; App coordinator `db({ raw, previous })`; Mac `sand-client-persistence` layout; product-contract §12 rollback wording.

Machine-local L2 receipts under `PRIVATE_EVIDENCE` are evidence, not this repository’s authority.

## 1. Unload grokbox preload / return Host to official

**Intent (legal, documented, not done = not official):**

```text
grokbox runtime deactivate
```

Registry: “Set desired mode to disabled; live coverage is observed by status only.” Implementation writes `desired.mode=disabled` and returns `chain: "desired-disabled"` (`packages/cli/src/commands/runtime.ts` `runRuntimeDeactivate`). No TERM, no inject, no adopt.

Accepted meaning ([product-contract](../product-contract.md) §12, [box-runtime](../box-runtime.md) §8): `deactivate` is the Agent’s sole large-rollback **intent** entry. The accepted recovery target is a single unpatched official chain. **The write receipt is not rollback-done.** While the Host is still patched, status must stay pending / `rollback_pending`. Prove with `runtime status` (`desired` vs `actual` / origin / coverage), not the deactivate JSON alone.

**Live unload (accepted design, not a current public CLI):**

- Self-heal `stale-patched` (one SIGTERM of the attested Host so official `sand-supervisor` respawns unpatched `host-main.cjs`) is **watchdog-only** (product-contract §12).
- Current source: `runWatchdogTick` / `runWatchdogCutover` / `runManualReadopt` throw `invalid_usage` (`legacy controller executor removed; use startControlOperation`). `runtime start` is `runtimeNotReady` until T26.
- Sole live writer remains `runtime re-adopt --confirm`. After deactivate, `inspectControllerFacts` returns `desired-disabled` and refuses the lease. `re-adopt` is for attested refresh / stale→official→transient-adopt when desired is still identity/route — not a deactivate executor.
- Forbidden Agent commands: `inject` / `heal` / `kill`. Do not invent a hand-TERM of the living attested Host.

**Future unload is blocked** until an owner-authorized live writer exists that: (1) honors desired=disabled, (2) TERMs only the attested grokbox Host identity, (3) waits for a unique official chain + Gateway pid match, (4) does not hand-clear `coordinator.json` / leftover `unknown` ops. L1b circuit `pending-uncertain` stays accept-open ([review ledger](review-ledger.md)); it is not an unload step.

Do not `deactivate` on this box while L2 always-emit dogfood is the living Host.

## 2. Verify roster harness always-emit

Use raw Gateway `listAgents` (or equivalent Host roster). CLI `agents show` / `compactRosterRow` **drop** `harness` — that is redaction, not emit proof.

| Host path | Expected roster `harness` |
|---|---|
| grokbox compile with `harness-blank` / `harness-summary` | always `"box"` or `"temporal"`; **never omit box** |
| official / stock `host-main.cjs` (no grokbox slices) | stock omit-box: temporal only; box agents **absent** |

Always-emit is grokbox slices, not an official Host patch. Unload therefore **returns omit-box** unless stock Host itself changes (private interoperability notes (not distributed) §1 / §8). Do not treat official restart as proof always-emit survived.

On this box, L2 already observed always-emit on the **attested grokbox** Host (43 `box` / 1 `temporal` / 0 absent). That does **not** prove the official path. Re-check `profile.json` + raw `listAgents` after any future unload.

## 3. Cmd-Q the desktop App

Coordinator Maps (`harnessOf` / `requiredAgents` / `m`) live for the **coordinator process**. Host restart and preload unload do not clear them. Need a full App exit (Cmd-Q / Exit), not closing a chat window. Owned by private interoperability notes (not distributed) §4 / §6.

Cmd-Q **does not** delete Mac `sand-client-persistence/`. Sticky temporal is gone; `restoredSeed` may still replay.

## 4. Optional: clear Mac replica only

If the desktop still shows “saved messages” / a truncated server window after Cmd-Q: delete Mac `~/Library/Application Support/Grok Bot/sand-client-persistence/` (or the `transcript.replicas` keys). **Not** box `/home/box/sand-data/agents/*/store.db`. private interoperability notes (not distributed) §5–§6.

## 5. Accept

After a **completed** official unload (intent + authorized execution + observed unpatched chain):

- Desktop and mobile read the **same** Gateway transcript source for a given id (no coordinator sticky-temporal; proxy only if roster `harness === "temporal"`).
- Box agents: Gateway tail = box `store.db` when Host is official and roster is omit-box or `box` (stock omit ≈ box for Gateway proxy; coordinator is the sticky risk, and it is dead after Cmd-Q).
- Composer-above Working under official uses proto `handleAgentUpdate` / `currentActivity` ([host-app-projections](host-app-projections.md)). Do not treat sidebar `isRunningTurn` as composer Working. App pixels stay N unless a live App poll/screenshot is cited.

This pass does **not** claim those accept criteria. Unload was deferred.

## 6. Pointers

| Surface | Owns |
|---|---|
| [transcript-harness-box-vs-server.md](transcript-harness-box-vs-server.md) | grokbox intercept needs `harness=box`; CLI `--harness`; Host `updateAgent` dogfood; always-emit slices |
| [host-app-projections.md](host-app-projections.md) | sidebar vs composer Working vs tray |
| grok-bot `private interoperability notes (not distributed)` | stock omit-box, proxy, Cmd-Q, Mac replica |
| `PRIVATE_EVIDENCE` | offline always-emit slices + CLI `--harness` |
| `PRIVATE_EVIDENCE` | packed re-adopt; 4-slice profile; live omit-box |
| `PRIVATE_EVIDENCE` | 8-slice reviewed profile; live always-emit on attested Host |
| `PRIVATE_EVIDENCE` | circuit still open; no legal closer |

## This pass

Checklist shipped. Living Host left grokbox-attested. Canary unset. No pack, no re-adopt, no deactivate, no circuit hand-clear.
