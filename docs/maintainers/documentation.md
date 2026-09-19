# Documentation maintenance

This page owns documentation roles, discovery, freshness and retirement. It does not define product or runtime behavior. Work from the affected claim; there is no repository-wide mandatory reading sequence.

## Resolve a disagreement

For statements about the current implementation, inspect the actual source, schema, migrations, command registry, dependency lock and executable tests. They take precedence over prose. Next use the latest applicable adopted change, including its scope; a new date on an unrelated document is not supersession. The 2026-09-19 source-first convergence explicitly replaces stale implementation descriptions, not historical observations.

Keep three facts separate: implemented behavior, accepted target, and observed deployment. Existing code may implement only part of a larger accepted target. Preserve that remaining obligation in its source ticket or roadmap rather than saying either “nothing exists” or “complete”. An unobserved runtime is unknown, even when the source is integrated. Security and authorization do not arise from implementation capability.

Change the owning claim, then update or remove repeated descriptions. Do not resolve a conflict by adding an override paragraph to every file. Do not change fixed reports to make their old versions, failures or missing proof look current.

## Homes and routes

| Role | Home and update rule |
| --- | --- |
| Product semantics | `docs/product-contract.md`; command registry/help owns exact command inventory |
| Architecture and runtime invariants | `docs/architecture.md`, `docs/box-runtime.md`, concern-oriented `docs/runtime/` |
| Configuration facts | Source schemas and `docs/configuration.md`; other pages link instead of copying current versions/defaults |
| Operating procedure | `docs/maintainers/`; examples must use implemented commands and state scope/side effects |
| Implementation/offline/review gaps | The owning ticket; the ticket index routes, not duplicates its progress |
| Current live result | `docs/tickets/LIVE-integration-validation.md`; one current row/evidence pointer per stable scenario |
| Fixed verification receipts | `docs/reports/`; bounded source/window and `notProven`, never a second live ledger |
| Retired research/delivery history | `docs/archive/`; preserve useful reasons/evidence without current instructions |
| Remaining targets/candidates | `docs/roadmap/`; distinguish accepted remainder from unaccepted extensions |
| Decision rationale | `docs/decisions/`; mark scope and supersession, incorporate current meaning into its owner |

`docs/README.md`, `CONTEXT.md`, ticket/roadmap maps and `AGENTS.md` are routes. They do not copy current schema/wire versions, pass counts, temporary blockers, PIDs, worktree inventories, candidate SHAs or model budgets. A version-sensitive guide links its code owner. A code or test reader should be able to find the relevant invariant by command/domain name without following old milestones.

Use English or Chinese according to the surrounding document. Preserve API identifiers and stable anchors. Write complete, direct sentences; prefer intent, invariants and completion evidence over role-playing a particular model or scripting its reasoning. Named models in historical reports are evidence, not a permanent reviewer/implementer assignment.

## Ticket identity and lifecycle

The canonical identity of an existing ticket is its full repository path, not a bare `T` number. Historic `T32` and `T43`–`T50` have multiple meanings. Display a domain-qualified label such as `modeld/T43` or `ops/T43` and link the exact file. New work uses a meaningful domain key (as CTX, CONT, OBS and HCR already do); do not renumber historical externally cited paths.

A ticket may retain fixed implementation receipts. Its current opening describes only its scoped remaining work and links the current contract. Old phases, earlier “next step” instructions and superseded layouts are not active orders. Do not set Done because a file exists, and do not leave implemented work described as absent. Independent review is an observed process outcome, not an automatic consequence of self-review or a tool error.

Before retiring a record, identify any unresolved finding, acceptance obligation or unique source reference. Route each to a current ticket or explicitly retain it for triage. A historical ticket can be archived without declaring its technical concerns resolved. Model-specific dispatch loops and personal-memory dependencies do not belong to current repository rules.

## Archive and evidence

Reports remain the canonical fixed-window receipt store because LIVE and its executable consumer use those stable paths. Archive is for material retired from current contracts and delivery instructions, including old research and review history. These roles are distinct: do not copy the same report into both directories. Archive's index can route to reports without acquiring their content.

Use direct text for historical facts worth reading. For removed repetitive plans already committed, an intentional archive note may give the exact commit/path and a `git show` recovery command instead of copying the entire obsolete plan. Verify that the source commit includes all removed text; dirty/untracked material is not protected by Git history. Do not publish private paths, raw dumps or hidden upstream code through either history surface.

Preserve known external paths/anchors with a short route when needed. Such routes own no current semantics, are absent from normal task maps, and should be retired only when their consumers are understood. An ordinary repository search cannot prove external bookmarks absent. Link current readers directly to the actual owner.

## Checks and completion

From the repository root:

```bash
bun run check:docs
bun run typecheck
```

The documentation check covers local paths/anchors, source-backed current contracts, discovery, LIVE structure and mutable-state fixtures. It does not fetch external/private pages or prove native behavior. If report syntax, parsers, commands or package surfaces change, run their tests and the package/build checks too. The root `package.json` and lock own toolchain versions; record actual versions rather than silently changing pins.

Completion means affected facts agree with their owners, current routes reach them without a historical detour, unresolved obligations and useful evidence survive, and changed consumers pass. File count and word count alone are not completion criteria.

The entry/Skill design follows the adopted principle of narrow triggers, on-demand references and bounded completion, informed by [OpenAI's September 11 article](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra) and the supplied docs-governance Skill. These references are rationale, not a build dependency or a required read for each task.
