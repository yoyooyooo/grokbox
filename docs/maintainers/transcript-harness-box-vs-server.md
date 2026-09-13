# Transcript harness: `box` vs `temporal`

> Publication note: operational identities below are synthetic examples. Private evidence locations and machine execution records are not distributed; historical observations do not qualify a current deployment.

**Role: grokbox implications of the stock App/Host dual ledger.** Not a second Host inbound map. Stock protocol (wire omit, Gateway proxy, desktop coordinator, Mac replica, Cmd-Q) is owned by grok-bot `private interoperability notes (not distributed)` (sibling checkout on this box: `PRIVATE_EVIDENCE`; not vendored here). Working / tray vs pixels stay in [Host / App live projections](host-app-projections.md).

**Current implementation ≠ accepted target.** CLI ordinary updates omit harness and explicit existing-harness edits are refused. The 15:56 UTC working-tree candidate also removes the five Host harness-write slices and their hook; the deployed Host has not been refreshed to it, so source retirement is not live alignment. [T37](../tickets/T37-server-ownership-admission.md) first installs real admission; [T38](../tickets/T38-identity-write-alignment.md) then removes implicit harness writes and retires local-over-Server behavior with preservation/impact checks. Read-only ownership and honest roster observation remain. No App modification or circuit clearing is authorized by this page.

## Official creation policy is not the CLI default

Stock App 0.47 resolves ordinary new-Bot creation from `getGrokBotRuntimeCapabilities`: temporalCreationEnabled plus durable identity read/write support; the old experiment gates are a compatibility fallback, not the primary test when capabilities are returned. Host-mediated creation similarly uses the official creation policy and optional explicit requested harness. Existing Bots follow their recorded identity; sending via CLI does not itself choose or migrate that identity. Grokbox's explicit box creation default is our interface behavior, not proof of the current account's stock App default.

Distinguish the server's persisted Agent harness, Box's materialized profile/roster, and Mac's local routing map. Cache restoration changes the last one (and thus actual send/read routing); it does not by itself mutate the first two or migrate context. Original protocol and exact source locations are owned by sibling `private interoperability notes (not distributed)` §1.1–1.2. Current account creation capabilities were not queried in this inspection; do not infer them from test canaries or the four transcript-read gates.

## Current Host-only boundary (2026-09-12)

Owner now explicitly excludes App patching/re-signing/injection and routine cache resets. The desktop mechanisms below remain evidence, not an App implementation plan. [Spec S0.1.1](../roadmap/box-runtime-impl-spec.md#host-only-model-switch) requires official/custom selection within one confirmed Box-owned conversation; choosing the official model is not choosing Temporal, and does not require unloading the bridge.

The original unfiltered Server `ListGrokBotAgents` response exposes `agentId` (public UUID), `id` (server row) and `harness`; the App `getServerAgentRoster` filters temporal rows and cannot certify absent rows as box. Generic identity Update does not contain harness. A dedicated official Box→Temporal migration pass exists in an applied Host upgrade window; no symmetric public reverse setter was found in the inspected contract. Full source evidence and the no-RPC protocol probe live in private sibling `private interoperability notes (not distributed)`.

Historical local `harness-server-write` retention was not proof of Server ownership or permanent Box pinning; it is removed from the current source candidate, while safe live retirement and conflict preservation remain T38 work. Server-temporal/local-box conflicts cannot be made production-safe by ignoring identity reconciliation, clearing migration holds, or suppressing App observations. A Host-only patch cannot intercept a main-model request already sent App→Server. Existing polluted clients and future official migrations therefore remain compatibility/acceptance boundaries, not promises that another re-adopt cures everything.

On confirmed compatible Box Bots, model swaps must keep identity/session/store and native state stable. The current working tree supports single-Bot `models reset --for` during route mode through the same scoped-ownership/configuration program; default/global reset remains protected, and deployment/native roundtrip are not implied. Official→A→B→official persistence/continuation must be tested bidirectionally. Full unpatched-Host rollback is a distinct gate.

## Read-only ownership inspection contract

**Implemented and live-read verified:** `agents ownership <targets...>` performs one bounded native Host→official `ListGrokBotAgents` call for named UUIDs, through an explicit namespaced extension of existing `getHostStatus`, never through identity reconciliation/migration. The Host keeps official credentials inside its existing client; Gateway/CLI receive only selected identity fields, local before/after declarations and the local migration-window observation. Ordinary status reads remain unchanged. The absence of this bridge or a failed/unknown server read must remain unconfirmed, not inferred box.

Ownership and desktop routing are distinct facets. Ownership classes are confirmed_box, confirmed_temporal, conflict and unconfirmed; desktop route is unobserved unless separately witnessed. The earlier fifth scenario (confirmed Box but a polluted App route) is a cross-cutting problem, not a fifth mutually exclusive server identity. An inactive local migration window does not prove the Server has no pending migration. A confirmed_box result is eligibility evidence, never production acceptance or automatic permission to switch models. Do not invoke Box→Temporal migration to enable custom models.

### Command, results and limits

In the current v2 checkout: `node dist/index.js agents ownership <agent-name-or-public-uuid>... --timeout-ms 20000 --json` (or `bun run grokbox agents ownership ...`). Direct Gateway and daemon transports are covered; explicit public UUIDs can be queried even without a matching local roster row. Names retain the existing unambiguous resolver. No raw Server identity, auth or model request is logged beyond the finite fields returned for the selected agents.

At 2026-09-12T11:55:59Z a real native Server query returned: test0 box/local box, test1 box/local box, test2 temporal/local box. The first two are confirmed_box, the third is conflict/harness_mismatch. Server row IDs also match each local binding; this is not name-based inference. Named private receipts/IDs remain in grok-bot docs26. No Bot was opt-in changed, no new test prompt was sent, and the new read path invokes neither reconcile nor migration. Host was re-adopted to load the read extension; status afterwards remained attested, modeld ready, recovery clear, existing circuit open.

Current output retains local before/after stability, Gateway generation change, unknown/missing/ambiguous identities, sanitized RPC failures and local migration windows. `productionAccepted:false`, `desktopRoute:not_observed` and `serverMigration:not_observed` prevent broader claims. This command remains read-only; [T37](../tickets/T37-server-ownership-admission.md) owns the separate real Host gate, [T24](../tickets/T24-runtime-route-binding.md) per-Bot choices, [T39](../tickets/T39-native-model-roundtrip.md) the actual native/App roundtrip, and [T40](../tickets/T40-persistent-release-and-rollback.md) release. They are not already passed by this query.

The earlier v1 read bridge was live-read verified as recorded above. The current candidate uses **schema3**: scoped backend/account/team/machine digest, bounded single-flight/cache, local identity and migration observations, plus before/after native `isLocalWorkAllowed` and `canExecute`. An inactive migration window alone does not prove local execution is permitted. Only stable/fresh scope with native allowed/bound true qualifies; v1/v2 remain diagnostic, not admission. The nine-case owned native-pause test subsequently passed; the earlier tool refusal is historical. On 2026-09-13, current-source native registry/resume/migration classes and the transformed Gateway property also passed isolated qualification with the actual packed reader. Neither proves whole-Host/live schema3 admission. See [T37](../tickets/T37-server-ownership-admission.md) and current [readiness](t32-live-enable-readiness.md), not old counts.

## Why grokbox cares

Managed `create-session` wraps `createCursorInferencePromptSession` (`packages/box-runtime/src/internal/host/live-slices.ts`). Host only constructs that factory for **box-hosted** turns. Agents whose Host `profile.json` / roster `harness` is `"temporal"` never hit the patched constructor ([T32 live-enable](t32-live-enable-readiness.md)).

```text
harness=box        → Host runs the turn on box → grokbox intercept can fire
harness=temporal   → Host does not run that turn locally → intercept skipped
```

`SendToUser` writes the native Box transcript when Host runs the turn. Server may hold a versioned replica of that same Box history, or a distinct Temporal execution's history; these are not interchangeable. Multiple copies are not automatically dual-SoT or a fork. Do not infer execution, missing tools or migration from which bubble source was painted. Server registration determines execution ownership; the active native owner commits its conversation facts.

## Retired write policy and deployment boundary (T38)

Creation can still request `--harness box|temporal` at the native `createAgent` root, then reads ownership once and reports confirmed/mismatched/unconfirmed without recreating or deleting. Ordinary `mergedProfile` now excludes harness; both CLI and typed Gateway/daemon update boundaries reject explicit existing-harness mutation. The five historical write slices are no longer active or accepted by current profile authoring. `harness-stick.ts` now contains only the pure retired-ID rejection rule; it cannot bind a writer. Loaded-profile transform and direct reauthor reject those IDs, while the two observation slices and the native ownership-read bridge remain.

Owned red/green tests prove profile conversion leaves native local/server writer bodies unchanged; a server-confirmed binding is no longer overridden by an existing local box value. This is not a public migration API or a live repair. A fresh reviewed profile, native gate qualification and test2 preservation/impact decision are required before deploying the candidate. Current native startup enters global identity reconciliation before resuming local work: retiring the write slices can align test2 to Server-temporal without an explicit reconcile CLI call. The owner separately approved a controlled startup-sync window on 2026-09-13, conditional on safety prerequisites and review; this is not a per-Bot-only mutation or proof it has run. Reusing an old profile or globally reconciling to force green is forbidden. Always-emit roster box still is not proof of managed execution.

## Acceptance must not mix transcript sources

A deliberate switch from temporal to box may expose a different existing transcript; it is not a transcript migration or proof of lost model context. Repeated display alternation after the switch is **not** an accepted steady-state behavior. A known mixed-history canary remains useful as a diagnostic counterexample; a clean box-only Bot is a separate acceptance subject, not a fix for the old one.

For each production acceptance observation, keep the Bot ID, send nonce/request ID, Gateway generation, declared roster harness and the correlated runtime identity. `agents show/list` and roster events must preserve the finite harness field; omission/unsupported data is **unknown**, not a made-up explicit box observation. `history outcome --expect-harness box` checks roster snapshots before and after collecting transcript/alerts; `--runtime` implies this box expectation, since local logs must not certify a server-proxied result. A sampled harness change, unknown declaration or mismatch invalidates that observation even when a message has the expected text. Separate samples are not an atomic snapshot and cannot rule out an unseen change-and-return.

These CLI observations cannot certify the exact App-visible replica. Do not merge stores by entry ID/time, directly rewrite profile/SQLite, clear caches or delete the Bot to manufacture a pass. The ordinary Server identity Update has no harness setter; an explicit local Gateway update is not a confirmed migration. T38's future native alignment is a separately confirmed write with bounded impact, never an implicit effect of this read command.

## Actual desktop recheck (2026-09-12)

The Mac installation was inspected directly: App 0.47.0 main/coordinator bytes match the retained research assets, and the renderer matches the archive integrity hash. The named test2 cache contains the old 16-entry transcript and a temporal roster row, while a fresh Box Gateway observation declares box and exposes the newer history. The four relevant cached feature-gate evaluations are false; per-Agent required routing can still select server.

The important new interoperability fact is that renderer `restore/connect/noteReconnect` replays cached temporal IDs through `restoreTemporalAgentRouting`, even when current rows contain an explicit box declaration. The coordinator accepts that command into the same classification map used by fresh Gateway roster updates. Original-function isolated replay demonstrates box → temporal → box without any Box profile/store mutation; server-roster merge can also overwrite a newer box row with an older temporal row. Follow-up Accessibility observation of the running App's selected test2 window shows the old ORBIT72/E2E history, so the desktop discrepancy is observed, not only inferred from a disk cache. The exact live IPC ordering is still unobserved.

**This also affects input routing.** The actual App command dispatcher routes `sendPrompt` through server actions for an Agent classified temporal. Extending the same isolated probe reproduces gateway → server → gateway → server as fresh Box roster, cached restore and server roster alternate; all transports are synthetic, no real send was made. A Box-direct CLI success therefore cannot qualify an App-originated managed TURN. This is a production entry/authority dependency, not merely T36 composer cosmetics.

The App's source-change event is global `{source}` while required routing is per-Agent. A per-Agent change can happen without the corresponding global sourceChanged transition. Transcript persistence has entries/epoch/sequence/time but no explicit route source/revision. Accepted production behavior must use one source-qualified decision for send, read, subscription and install; changing that decision must invalidate old-source responses. Merely adding a global refresh or preferring whichever row has a newer timestamp is insufficient.

Detailed private source pinning, Mac observations and the reproducible read-only probe remain in sibling `private interoperability notes (not distributed)` and `scripts/verify-desktop-transcript-routing.cjs` (11 behavioral assertions, same checked bytes on Mac and Box). No App code/cache is vendored here. Re-adopting Host, clearing only transcript cache, or creating another Bot does not close the desktop route-authority gap. Production acceptance needs cached-restore, reconnect, stale server-row and legitimate-temporal negative controls; the existing CLI bracketed harness observation still cannot certify the desktop-selected replica.

## Patching expectation

Keep positive overflow / managed-session canaries on **Server-confirmed box with matching local identity**, not merely a locally forced `harness=box`. test0 is the current ownership-qualified candidate; test1 remains official; **test2 is now a confirmed identity-conflict fixture and is removed from positive/heavy managed acceptance**. It remains available for controlled diagnosis and future repair calibration, not new model work. A temporal fork is a different product path: its Server main-model execution does not reach our Host session hook. The accepted gate-before-write-cleanup and roundtrip sequence is [Spec S0.1.2](../roadmap/box-runtime-impl-spec.md#server-authority-rollout).

`activity-bridge` supplies part of the native activity contract on managed turns; generic Working does not require a non-null currentActivity (T36), and one field is not full UI qualification. It does **not** hydrate historical bubbles and does **not** copy Host `send-message` into the Cursor server replica. Desktop chrome / sticky-temporal leftover is [composer-working-status](composer-working-status.md). See [host-app-projections](host-app-projections.md).

## Clean rollback vs always-emit harness

Stock Host `buildSummary` emits `harness` **only** when `"temporal"`; box is omitted. Desktop coordinator `db({ raw: undefined, previous })` **keeps** a prior `temporal`. Official Host restart therefore cannot unstick a desktop that already classified a canary as temporal, and it cannot clear Mac `transcript.replicas`.

Always-emit Host slices (`harness-blank`, `harness-summary`) replace omit-box spreads with `harness: … ? "temporal" : "box"`. An explicit local route is not automatically superior to Server registration. Correct original-App behavior must be observed after supported identity alignment; App-side issues remain compatibility boundaries, not permission to patch the client or suppress official migration. Cmd-Q ends only the current maps; persisted roster restore can recreate them. Cache isolation is an authorized diagnostic control, not a default repair or a production pass. Living emit still requires those slices on the compile in use; official Host without grokbox slices stays omit-box. See [official-rollback-acceptance](official-rollback-acceptance.md).

Live unload of an attested Host is out of scope for this document. Circuit `uncertain-operation` remains a live-writer blocker elsewhere; do not hand-clear. Machine-local L2 receipts under `PRIVATE_EVIDENCE` observed always-emit on an attested grokbox Host; they are not repo authority.

## Dated observation (not a standing inventory)

2026-09-11 receipts (machine-local, not repo authority): test2 KV had evening canary `send-message` rows while Gateway tail returned a different 8-row server replica after `profile.harness` became `temporal`. App pixels N. Re-check `profile.json` + `listAgents.harness` before citing those counts.
