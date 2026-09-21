# Runtime evidence diagnostics

Advanced, read-only follow-up when [send](send.md) leaves missing/conflicting evidence or an error banner gives a STEP: `grokbox skills get grokbox --topic diagnostics`. Not default startup reading.

## Correlate the original work

For confirmed box-local execution, correlate modeld evidence:

```bash
grokbox history outcome <agent-id> --nonce <clientNonce> --runtime --json
# Alternative: use the exact model STEP from an error banner.
grokbox history outcome <agent-id> --step-id <step-id> --runtime --json
```

For a confirmed temporal route, query the original nonce with `grokbox history outcome <agent-id> --nonce <clientNonce> --expect-harness temporal --json`, without `--runtime`; local modeld history does not describe server execution.

Choose one selector. A model STEP is not necessarily the first display request-id. `--request-id` looks up the same send, not a new operation. A null request ID can accompany an early failure. Never manufacture a new send to obtain an observation handle.

## Admission is not a Provider failure

For `ownership_bridge_unavailable`, inspect the finite `localWitnessFailure` when present: source/schema mismatch, missing observation, scope change, missing/duplicate target rows, invalid clock and expired local evidence have different repair paths. Do not infer an old Host from that top-level code alone. `confirmed_box` is Server registration evidence, not a fresh local-only execution permit.

Doctor's `hostCapabilities` compares the actually loaded wrapper/reader and profile identity; it makes no Server List or model request. `modeldAdmission=ready`, Host `custom`, and `next=none` are not Provider roundtrip proof. A loaded-profile mismatch requires scoped component adoption, not another model assignment. For interrupted `operation-busy`, inspect `runtime operation-recovery --json` and read [adopt](adopt.md#interrupted-controller--identity-operation); never clear locks by guessing a PID. Keep the original STEP/nonce, and do not replay a failed send as a diagnostic probe.

## Inspect a queued notification without sending it

```bash
grokbox notification list
grokbox notification get <notification-ref>
```

These authenticated management views read the original outbox without initializing a store, pairing, reading Webhook credentials, starting monitoring or sending. References bind the installation and original database; pages cover retained work, not complete upstream history. Configured target preferences do not prove pairing or authorization. `notification status` observes the management-owned worker separately. A stopped Server is not permission to bypass it with local-file or Gateway reads.

A reserved/attempting/unknown record is not permission to retry. Keep the exact work/attempt ID and evidence revision. `native-accepted` means only the transport's acceptance boundary, never Bot completion or user read; the latter remain separately unobserved. Do not create a new work, switch target aliases or re-run a business task to bypass the uncertain record. The default alert task still only reminds and ends.

## One explicitly authorized notice delivery

Only when the user specifically authorizes sending one existing notice (including possible native usage), use:

```bash
grokbox notification receiver get <receiver-ref>
grokbox notification receiver verify <receiver-ref>
grokbox notification send <notification-ref> --receiver <receiver-ref> --request-id <persisted-uuid> --expect-revision <n> --expect-model-revision <sha256> --confirm
grokbox operation get --domain notification --database-id <original-database-uuid> --request-id <original-request-uuid>
```

Persist the request UUID and both scoped references before submission. Take the binding revision from `notification receiver get` and the reviewed model fingerprint from `notification receiver verify`. The independent `notifications.send` capability is required; read, test and enable rights are not send authority. The managed reminder Routine must already have been separately enabled without other definition changes; send never enables it or mints a key. Changed model, ownership, scope, definition, permission or pairing stops the attempt. The program takes the fixed safe body from the existing incident outbox, not arbitrary text, a URL, a key, supplied JSON or test work.

HTTP acceptance is not the Bot's completed reminder or user read. Refused delivery returns exit 5; uncertain submission returns exit 8 and the original lookup locator. Reading a receipt may exit 0 while its state remains unknown. A previous attempt, timeout or unknown result is not permission to retry under another request or work ID. This one-shot path does not enable background delivery or bypass installation/target wake limits. An automatic alert-receiving Bot must not use it unless a later user task authorizes it.

## Separate gaps from failures

If modeld was started with an explicit `GROKBOX_RUN_ROOT`, pass the **same** value to `history outcome --runtime` and inspect `evidence.runtimeRoot`. Do not assume every `runtimeGap` is a root mismatch: permissions, malformed records, partial append, and retention have different meanings. Large journals are byte-windowed rather than rejected wholesale.

Read `assessment` and `evidence` alongside state. A known runtime gap prevents a mere progress reply from qualifying the observation as settled delivery; actual delivery remains in `delivery`. A correlated explicit failure still wins even with a partial window. Empty alerts do not override failure evidence.

`runtimeFailure.diagnostic` names the instrumented rejection site/cause. `runtimeTrace` is bounded evidence, not a raw provider dump. Report the known failing boundary separately from any unproved deeper cause; do not expose raw provider content or credentials.

## Completion and liveness are separate claims

`executionCompleted` remains `not_proven`. With `--wait-for execution --runtime`, a progress reply does not settle the wait; current execution waiting stops early on failure, otherwise at the wait budget. It cannot manufacture successful whole-run completion proof.

Native trigger/lineage facts do not authorize a retry. Released tool materials are not proof of tool execution or checkpoint commit. Timestamped writer-health snapshots are not current process-liveness proof. A sidebar spinner, current-session Working indicator, and per-message streaming do not establish the same scope of activity.

## A Bot remains Working after its parent turn ends

First preserve the Agent/session, visible surface, timestamp and original send identity. Read `grokbox agents show <agent-id> --json` and `grokbox agents ownership <agent-id> --json`. A qualified Host may return `activityObservation` separately from the ownership decision. Confirm the loaded Host generation and `instrumented`; a new source commit is not a deployed observer.

Classify before changing anything: a fresh session frame with `isRunning=false` / `hasRunningSubagents=true` calls for the native child owner; an overdue frame with a still-busy current overlay calls for timer/reconnect investigation; a confirmed idle producer with a spinning App calls for client-state investigation. Missing fields, truncated sessions and an absent overlay during reconnect mean incomplete evidence, not idle. Keep the valid empty default session ID. Compare actual server timestamps/TTL, not roster last-message time or the query timestamp; retained session witnesses are not a current child-task registry.

Local task lists do not enumerate temporal server children. External worker completion does not stop its native listener, and `hadActiveRun=false` is not a child-stop receipt. With **current explicit stop authorization**, have the real native execution owner enumerate (`CheckSubagent` without an id) and stop only confirmed in-scope children (`StopSubagent`, using that runtime's actual schema). These are native tools, not grokbox CLI commands. Clean owned background waits through verified task handles; never bulk-kill by command name or a guessed/stale PID. Report unavailable capabilities and remaining unknowns.

Where no external child-control API exists, a separately authorized maintenance message can ask that owner to clean up without continuing business work or creating new listeners. It is a new model operation with a new recorded nonce, not a resend of the failed message. An unknown send result requires querying the same nonce, not sending again. Do not treat the maintenance reply, `accepted`, or a temporary post-restart idle view as successful cleanup.

Verify a later explicit server idle frame, the current overlay and roster, then take bounded follow-up observations across the relevant TTL. Missing continuous coverage limits the claim to observed times. App rendering needs separate evidence; a failed/stuck optimistic message remains a separate send-journal issue. Do not change harness or force running=false. Reboot/upgrade only to repair a separately established deployment/observation gap, under the [adopt](adopt.md) authorization rules. New legitimate work is not a relapse and does not authorize another stop.

Maintainers with a source checkout: `docs/maintainers/working-state-recovery.md` contains the full runbook, maintenance template and recurrence/prevention limits. It is not shipped in the npm package; the operational boundaries above remain usable without that file.

Stop after the authorized observation budget. Share the redacted state, selectors, gap/rejection codes, and what remains unproved; do not silently replay business work, switch Host, or start a persistent monitor. Host failures route to [troubleshoot](troubleshoot.md); deliberate model-switch acceptance lives in [validation](validation.md).
