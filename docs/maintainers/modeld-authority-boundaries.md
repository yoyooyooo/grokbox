# Modeld authority boundaries and attribution

Current implementation map, updated 2026-09-17 for the [AUTH follow-up](../tickets/AUTH-ownership-evidence-availability.md) on v2 baseline `f8c82c0`. [T43](../tickets/T43-modeld-authority-baseline.md) retains the historical `43166b6` baseline; its former first-waiter cancellation, generic poison and global storage-lock defects are not a description of the current core. Accepted behavior belongs to [Spec S10](../roadmap/box-runtime-impl-spec.md#modeld-effect-core); this map records source boundaries, not a second specification or current deployment qualification.

## What is established

| Fact / owner | Current source / proof route | Consequence |
|---|---|---|
| Server registration read is a scoped list, not a proven execution lease | `docs/upstream-integration.md`, Official registration inspection; `host/ownership-slices.ts` | Retain the current evidence gate until stronger native coverage is proven; do not promise instantaneous remote revocation |
| Source evidence keeps its request-start age: max 5 s; cross-STEP cache 2 s; same live STEP may reuse its validated operation within 5 s under policy v2 | `contract/authority-policy.ts`; `io/ownership-coordinator.node.ts`; `ownership-availability.test.ts` | Fewer remote samples within one STEP is an explicit observation-frequency tradeoff, not a new lease or response-time renewal. Source deadline and cumulative STEP qualification allowance remain 10 s |
| Native source has its own deadline/controller and waiter count; modeld source is service-owned and waiters are request-owned | `host/ownership-read.ts`; `io/ownership-coordinator.node.ts`; `ownership-native-source-lifetime.test.ts` | Cancelling one waiter cannot abort another's required source; uncooperative physical operations retain their bounded slot until settlement |
| Local execution is observed as before/after `allowed` and `bound` | `host/ownership-slices.ts`; `ownership-native-pause.test.ts` | Necessary local pause/binding facts; not enough to establish per-Agent/per-TURN authority or remote revocation |
| Every production authority read surrounds the native read with deployment reads | `roots/modeld.runtime.ts`, `liveAdmissionAuthorityLayer` | Remote registration, local deployment proof and current execution fence have different owners but share a hot path |
| Each deployment read takes two snapshots of desired, attestation and operation journal | `io/store.node.ts`, `modeldStorePorts` | Four three-file logical snapshots per successful full authority check; not a measured syscall or disk-latency claim |
| Eligible transient read failure can recover within one claimed STEP; exhausted waits close, explicit invalidation revokes | `inference/authority-gate.ts`; `contract/authority-policy.ts`; `authority-gate.test.ts` | `open/closed/revoked` is monotonic after terminal. Read recovery cannot replay inference or revive an old TURN |
| Execution updates serialize by TURN identity and use short validated global commits; storage does not hold a global mutation lock | `inference/route-binding.ts`; `execution-state-concurrency.test.ts` | Unrelated execution can progress during slow storage; benchmark receipts remain workload-specific, not a production P99/SLA |
| Persistent identity writes use sync acknowledgement; a new service incarnation retires the old index | `io/execution-history.node.ts` | Preserve claim-before-effect and old-epoch fencing; do not turn durability into optional telemetry |
| Ensure/start use the single Effect service-acquisition program with owned/borrowed lifetime | `roots/modeld.runtime.ts`; `modeld-service-lifetime-parity.test.ts` | Preserve the Promise facade at the host boundary; borrowing does not own the external service's shutdown |
| Transport owns bounded sockets and STEP scopes; kernel owns inference meaning | `modeld/server.node.ts`; `inference/step-program.ts` | Keep existing structured resources; do not start a second execution kernel |

Paths above abbreviate `packages/box-runtime/src/internal/` or `packages/runtime-kernel/src/internal/` as appropriate. Tests are in their owning package's test directory.

## Native coverage matrix and decision

| Required property | Current available evidence | Qualification |
|---|---|---|
| Server/local Agent identity and harness agree | Scoped registration DTO + local before/after identity | Implemented snapshot check; not a lease |
| Account/team/backend/machine isolation | Hashed scope before/after source read | Implemented scoped check; remote consistency unspecified |
| Local work pause and executor binding | Native allowed/bound before/after | Implemented necessary condition |
| Original Host/source/profile generation | Canonical attestation + request HostEpoch, checked before/after read | Implemented local fence |
| Per-Agent/per-TURN native authority continuously bound to managed inference | No qualified capability in the current public adapter | **not proven**; cannot replace Server gate with two booleans |
| Remote revocation reaches all managed dispatches without polling gap | No source revision/lease/continuous coverage proof | **not proven**; no instantaneous guarantee |
| Final tool execution after approval consumes a current permission | Host owns tools; managed output gate is a different boundary | **not proven for every native version**; requires fixed-source consumer proof |
| Session interception does not bypass required native policy | Exact profile and passthrough tests establish part of the surface | Keep T39/native three-route qualification separate |

**Current implementation decision:** preserve the supplemental registration gate and all local fences while consolidating its owner/lifetime. This is a resolved conservative default, not a blocker requiring a new upstream capability. An affirmative native-capability proof may later retire redundant reads only through a new version-qualified decision. Unknown coverage is not permission to ship two competing admission paths.

## Attribution rules

1. Record the first wrong state, its writer and the failure trigger. Do not assign fault from the UI stage alone.
2. Separate external trigger from grokbox amplification: a slow List may be external; the five-second cutoff, sampling frequency and cumulative qualification budget are our policy. Bounded read recovery now precedes terminal refusal; a returned stale observation is not evidence of temporal takeover.
3. Distinguish absent upstream capability from violated upstream contract. A list lacking leases is not by itself an upstream bug.
4. A correct aggregate Working flag caused by live child tasks is not a modeld defect. App nonce/echo issues require App/receipt evidence rather than ownership changes.
5. A source cancellation code does not establish who cancelled it. Capture operation linkage or leave origin unknown.
6. A source-proven bottleneck opportunity is not a measured production bottleneck. Benchmark with a frozen workload before claiming latency improvement.

## Three-route comparison

Use isolated fixed-version fixtures or explicitly authorized environments:

- Unpatched Host with the original model route.
- Patched Host with an unassigned official-passthrough Bot.
- Patched Host with the managed route and controlled source/provider capabilities.

Only the second route failing suggests patch intrusion; only the third failing still requires separating policy, adapter and provider effects. Similar UI symptoms do not prove identical causes. Native source/corpus artifacts remain private and never become public build dependencies. The comparison runner must report unavailable native inputs as missing evidence, not substitute synthetic output and declare native qualification.

## Proof and remaining limits

`verify:modeld-core baseline` covers classifiers, scoped reads, local fences and architecture. `verify:modeld-core availability` exercises the production coordinator/gate/STEP combination, persistent moderate latency with and without the reuse capability, long preparation/inference, failure presentation, real fixture Unix/Host/journal/SQLite cold-read paths and privacy. It does not call a live provider or establish remote Server consistency, original-App behavior or actual tool consumption after approval. The final source-bound receipts are in AUTH, and broader release receipts remain T49.

The read-only `test:native-host` route has also been exercised for the AUTH candidate against the fixed SHA in `native-host-qualification.ts`: isolated native snippets, retry fences and approved copy transforms are within that proof, with the live file/PIDs unchanged. This is partial native-source qualification, not proof that the running Host/modeld loaded this feature, nor a complete three-route/native authority acceptance. Real Gateway lifetime, long-approval tool consumption and App presentation remain feature-scoped entries in the [LIVE backlog](../tickets/LIVE-integration-validation.md). Independent review is a non-live gate in AUTH/T49; it cannot be replaced by a live receipt.
