# Runtime evidence diagnostics

Advanced, read-only follow-up when [send](send.md) leaves missing/conflicting evidence or an error banner gives a STEP: `grokbox skills get grokbox --topic diagnostics`. Not default startup reading.

## Correlate the original work

```bash
grokbox history outcome <agent-id> --nonce <clientNonce> --runtime --json
# Alternative: use the exact model STEP from an error banner.
grokbox history outcome <agent-id> --step-id <step-id> --runtime --json
```

Choose one selector. A model STEP is not necessarily the first display request-id. `--request-id` looks up the same send, not a new operation. A null request ID can accompany an early failure. Never manufacture a new send to obtain an observation handle.

## Separate gaps from failures

If modeld was started with an explicit `GROKBOX_RUN_ROOT`, pass the **same** value to `history outcome --runtime` and inspect `evidence.runtimeRoot`. Do not assume every `runtimeGap` is a root mismatch: permissions, malformed records, partial append, and retention have different meanings. Large journals are byte-windowed rather than rejected wholesale.

Read `assessment` and `evidence` alongside state. A known runtime gap prevents a mere progress reply from qualifying the observation as settled delivery; actual delivery remains in `delivery`. A correlated explicit failure still wins even with a partial window. Empty alerts do not override failure evidence.

`runtimeFailure.diagnostic` names the instrumented rejection site/cause. `runtimeTrace` is bounded evidence, not a raw provider dump. Report the known failing boundary separately from any unproved deeper cause; do not expose raw provider content or credentials.

## Completion and liveness are separate claims

`executionCompleted` remains `not_proven`. With `--wait-for execution --runtime`, a progress reply does not settle the wait; current execution waiting stops early on failure, otherwise at the wait budget. It cannot manufacture successful whole-run completion proof.

Native trigger/lineage facts do not authorize a retry. Released tool materials are not proof of tool execution or checkpoint commit. Timestamped writer-health snapshots are not current process-liveness proof. A sidebar spinner, current-session Working indicator, and per-message streaming do not establish the same scope of activity.

## A Bot remains Working after its parent turn ends

Read `grokbox agents ownership <agent-id> --json`. A qualified Host may return `activityObservation` separately from the ownership decision. Compare the raw session's `isRunning`, `hasRunningSubagents`, server timestamps, TTL and timer receipt with the current overlay. A fresh child-only frame can keep the sidebar active while the current conversation is idle. Local task lists do not enumerate a temporal Bot's server-side children; an external worker ending does not stop a native listener watching it. `hadActiveRun=false` from a parent interrupt is not proof that children stopped.

Do not fix this by changing harness or forcing running=false. With explicit stop authorization, the Bot's native execution owner must enumerate and stop its own children/background waits. Then verify a later server frame and the roster are idle beyond the relevant TTL; do not treat a maintenance reply or a temporarily absent overlay after restart as proof. A failed/stuck optimistic message is a separate send-journal issue: preserve its nonce and never resend it as a diagnostic shortcut.

Stop after the authorized observation budget. Share the redacted state, selectors, gap/rejection codes, and what remains unproved; do not silently replay business work, switch Host, or start a persistent monitor. Host failures route to [troubleshoot](troubleshoot.md); deliberate model-switch acceptance lives in [validation](validation.md).
