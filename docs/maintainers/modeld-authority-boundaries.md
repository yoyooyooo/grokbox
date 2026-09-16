# Modeld authority boundaries and attribution

Current source audit, 2026-09-16; baseline commit `43166b6`. The accepted target is [Spec S10](../roadmap/box-runtime-impl-spec.md#modeld-effect-core), not this evidence map. [T43](../tickets/T43-modeld-authority-baseline.md) owns baseline proof; later tickets must update changed anchors and state their claim ceiling. No current native deployment is qualified by this document.

## What is established

| Fact / owner | Source at baseline | Consequence |
|---|---|---|
| Server registration read is a scoped list, not a proven execution lease | `docs/upstream-integration.md`, Official registration inspection; `host/ownership-slices.ts` | Retain the current evidence gate until stronger native coverage is proven; do not promise instantaneous remote revocation |
| Source evidence is conservatively aged from request start; default max age 5 s, source deadline 10 s, cache 2 s | `contract/ownership.ts`; `host/ownership-read.ts`; `ownership-scope-cache.test.ts` | A slow successful source can be unusable for execution; changing this is policy, not timestamp cleanup |
| Source Promise uses the original caller's AbortController; waiters have distinct timers | `host/ownership-read.ts`, `bindHostOwnershipRead` | Shared timeout may surface as generic source failure to a later waiter; source and waiter lifetime must be separated |
| Local execution is observed as before/after `allowed` and `bound` | `host/ownership-slices.ts`; `ownership-native-pause.test.ts` | Necessary local pause/binding facts; not enough to establish per-Agent/per-TURN authority or remote revocation |
| Every production authority read surrounds the native read with deployment reads | `roots/modeld.runtime.ts`, `liveAdmissionAuthorityLayer` | Remote registration, local deployment proof and current execution fence have different owners but share a hot path |
| Each deployment read takes two snapshots of desired, attestation and operation journal | `io/store.node.ts`, `modeldStorePorts` | Four three-file logical snapshots per successful full authority check; not a measured syscall or disk-latency claim |
| Read failure poisons an existing TURN | `inference/step-program.ts`, `readAuthority` | Temporary absence and explicit revocation are not adequately separated before terminal |
| Claim, binding, settlement and cooling use effectful global synchronized updates with storage I/O | `inference/step-program.ts`; `inference/route-binding.ts` | Potential head-of-line coupling; no throughput/P99 result has yet been measured |
| Persistent identity writes use sync acknowledgement; a new service incarnation retires the old index | `io/execution-history.node.ts` | Preserve claim-before-effect and old-epoch fencing; do not turn durability into optional telemetry |
| Service acquisition is repeated in ensure and start | `roots/modeld.runtime.ts`, `ensureModeld` / `startModeldProcess` | Consolidate implementation while retaining owned/borrowed behavior and Promise host boundary |
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
2. Separate external trigger from grokbox amplification: a slow List may be external; the five-second cutoff and immediate STEP rejection are our policy.
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

The `verify:modeld-core baseline` case exercises production ownership classifiers, scoped Host reads, local pause fences, STEP denial without provider effects, lifecycle behavior and architecture import fences. It does not call a live provider or qualify an App UI, native migration, release policy or throughput. Individual test exits and dependency pins must be recorded after execution; this map never claims a planned command has passed.
