# Runtime rebuild: fixed pre-convergence baseline

Historical scope: the repository at `4181e5ec822b6a199681822c7b597710c1195a44` (2026-09-19), immediately before source-first documentation convergence. The feature worktree began clean at that exact commit. This page preserves access and reasons; it does not certify implementation, deployment or permission.

## Recover the exact retired text

The following committed originals are preserved by that Git object, without copying all obsolete instructions into the active docs tree:

```bash
git show 4181e5ec822b6a199681822c7b597710c1195a44:docs/roadmap/box-runtime-impl-spec.md
git show 4181e5ec822b6a199681822c7b597710c1195a44:docs/roadmap/box-runtime-plan.md
git show 4181e5ec822b6a199681822c7b597710c1195a44:docs/roadmap/host-seam-ops-recognition.md
git show 4181e5ec822b6a199681822c7b597710c1195a44:docs/roadmap/template-ops-automation-spec.md
git show 4181e5ec822b6a199681822c7b597710c1195a44:docs/roadmap/configuration-rebuild-spec.md
git show 4181e5ec822b6a199681822c7b597710c1195a44:docs/box-runtime.md
git show 4181e5ec822b6a199681822c7b597710c1195a44:docs/product-contract.md
git show 4181e5ec822b6a199681822c7b597710c1195a44:docs/architecture.md
git show 4181e5ec822b6a199681822c7b597710c1195a44:docs/effect-box-runtime.md
git show 4181e5ec822b6a199681822c7b597710c1195a44:docs/tickets/README.md
```

A shallow checkout may not contain this object; history access is for optional research, never a build/test requirement. Source retrieval preserves the precise original text rather than treating sanitized `pre-publication-revision` labels inside it as resolvable SHAs.

## Why the old plans were retired

The early POC rebuild required a deliberate single program, package boundary and removal of response-only/parallel runtime paths. Its phases and target file tree were useful construction tools. Later execution-core, context, configuration, observations and current-state work landed at the same homes, while the plans still said to start T20/T21, used old wire/schema descriptions and kept adding dated override sections.

The useful invariants are one writer/program, native Host ownership, explicit applicability, no unknown-effect replay and separately qualified artifacts. They survive. The old internal API/layout, order of implementation, fixed model/fixture names, GATE enablement and particular reviewer model choreography are not ongoing compatibility obligations.

Source consolidation did not mean complete native qualification. Fixed report failures and independent review gaps remain evidence, not things erased by cleaner prose. Source integration never proves the installed CLI or Host adopted it.

## Where the surviving obligations went

| Prior material | Current owning home |
| --- | --- |
| Product commands, profiles, input/output, trust and capability boundaries | [Product contract](../product-contract.md), actual registry/help |
| Layout, ports, composition, fact/resource ownership | [Architecture](../architecture.md), current code exports |
| S0/S3–S5/S10 execution and authority | [Execution](../runtime/execution.md) |
| S11 reasoning R01–R06 | Execution's reasoning matrix and reasoning source ticket |
| S12 / CTX-A01–A16 / CTX-R01–R07 | [Context](../runtime/context.md), CTX tickets and Pi provenance |
| S13 primitives, full handover/retirement and per-duty safety | [Continuity](../runtime/continuity.md), CONT-00–11 |
| V01–V30 across domains | [Runtime acceptance](../runtime/acceptance.md) |
| F1–F6 / E01–E11 managed-context properties | [Managed continuity](../maintainers/managed-context-continuity.md) |
| HSO-0–6 and HCR-01–04 | [Host compatibility](../runtime/host-compatibility.md), HCR tickets |
| E01–E08 incident requirements, notification/sender, storage and J1 | [Operations](../runtime/operations.md), OBS/ops tickets |
| config schema/writer/migration/bootstrap/aliases | [Configuration](../configuration.md) and its source authority |
| Deferred browser/backends/external capabilities | [Roadmap](../roadmap/README.md), not a production prerequisite |
| Actual current live qualification | [LIVE](../tickets/LIVE-integration-validation.md), not any table in these historical plans |

Stable old file paths/explicit anchors are compatibility routes only. Normal maps link directly to current owners. A source ticket still using an old anchor reaches the corresponding current contract, not the retired task sequence.

## Bounded corrections

At the fixed baseline, config schema was 4, wire 8, and the package had three unpublished workspaces plus runtime native dependencies. Routine/provision/current-state/automatic sender had partial implementations; complete clone/handover, collector installation, whole-installation storage and various review/native/live gates were not thereby complete. Those facts explain why blanket “not implemented”, “two workspaces”, “empty dependencies”, and older values in current prose needed correction.

Do not rewrite old report schema numbers or observed failures to the new source state. Later changes must update their actual code/contract owner, not append another global “latest decision” to a historical file. The [governance owner](../maintainers/documentation.md) defines this rule.
