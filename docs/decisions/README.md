# Decisions

Decisions explain an adopted choice and its scope. Their current meaning is incorporated into the owning contract; a decision is not another implementation status table or execution permission. Source/schema/tests own implementation facts. Use the latest applicable adopted change, not simply the newest date anywhere in this directory.

| Decision | Scope and current owner |
| --- | --- |
| [Offline/live separation](2026-09-07-offline-live-adjudication.md) | Original J13/resource and proof boundaries; current [Effect standard](../effect-box-runtime.md) and [LIVE](../tickets/LIVE-integration-validation.md) own present application |
| [Host seam normalization](2026-09-08-host-seam-normalization-and-roadmap.md) | Native/managed boundaries, exact patch semantics and earned concurrency; [architecture](../architecture.md) and [Host compatibility](../runtime/host-compatibility.md). The real second-writer condition has since occurred; old “not yet CAS” observations are not current facts |
| [Modeld core](2026-09-16-modeld-effect-core.md) | One STEP program, source/waiter lifetime and bounded authority; [execution](../runtime/execution.md) |
| [Early template operations](2026-09-16-template-ops-automation.md) | Historical default behavior superseded by the September 18 operations decision; retain rationale, not the old default support/issue path |
| [Local context maintenance](2026-09-17-local-context-maintenance.md) | Proactive local checking and reuse rather than waiting for provider overflow; [context](../runtime/context.md) |
| [Reasoning policy](2026-09-17-model-reasoning-policy.md) | Captured assignment and final request evidence; [execution](../runtime/execution.md#model-selection-and-reasoning) |
| [Early ops defaults/support](2026-09-17-ops-defaults-support-and-routines.md) | Routine direction survives; default issue offer/automation is superseded by September 18 |
| [Early routing/issues](2026-09-17-ops-routing-and-authorized-issues.md) | Recipient/data/permission separation survives; old automatic publication mechanism is not current scope |
| [Unified configuration](2026-09-17-unified-configuration-rebuild.md) | Two human documents and one writer per domain; [configuration](../configuration.md). Historical schema examples are not current accepted input |
| [Observable native Bot operations](2026-09-18-observable-native-bot-ops.md) | Evidence-first, reminder-only default, delegated autonomy and bounded storage; [operations](../runtime/operations.md) |

Keep historical observations and rejected alternatives intact. When a newer change supersedes a decision, state the affected meaning and link the new owner; do not update old receipt counts or mark an unobserved deployment as adopted. [Archive](../archive/README.md) is for retired delivery/research narratives, not an automatic destination for every dated decision.
