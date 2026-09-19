# Agent instructions

## Work from the task

`grokbox` is the published npm package and CLI; `gbox` is its exact binary alias. Grok Bot is the upstream product. Keep upstream protocol/product identifiers unchanged. The unpublished workspaces are `packages/cli`, `packages/runtime-kernel`, and `packages/box-runtime`.

Use the affected source, tests, and command as the starting point. [CONTEXT](CONTEXT.md) describes the product; [the documentation map](docs/README.md) routes by question. Load only the relevant contract or Skill, not the whole documentation tree.

For current implementation conflicts, source/schema/lockfile and executable tests win; use the latest applicable adopted change next. Keep accepted but unimplemented targets explicit. Neither source presence nor a historical test proves the running installation. [Documentation maintenance](docs/maintainers/documentation.md) owns the full rule.

## Complete the authorized change

In an isolated feature worktree, carry implementation, relevant offline checks, and fixes through to the requested outcome. Do not stop after a plan or require approval for each routine step. Preserve unrelated work. Report the actual checks, results, and remaining limits; do not fabricate an independent review.

Commands run from the repository root. Resolve toolchain versions from `package.json` and `bun.lock`. `bun run typecheck`, `bun run build`, and targeted `bun test <files>` are development checks, not live acceptance. Documentation-only changes use `bun run check:docs`; broaden checks when changed consumers or failures require it. Native/provider/service suites require their documented isolation or authorization.

## Project boundaries

Keep one writer for each fact. [Architecture](docs/architecture.md) owns composition and trust boundaries; [runtime](docs/box-runtime.md) routes execution, context, and continuity contracts. Apply [the Effect standard](docs/effect-box-runtime.md) to runtime side effects. Host/preload remains Effect-free and SDK-free.

This public repository must build and test without private upstream research. Keep only necessary interoperability facts in [upstream integration](docs/upstream-integration.md) and owned fixtures. Do not copy private application code, provider dumps, transcripts, machine-local evidence, or credentials into the repository.

Do not put Cursor, Gateway, daemon, SSH, or tailnet credentials in argv, fixtures, snapshots, normal output, or logs. Gateway, daemon, Sandbox, and quota capabilities remain separate. A suggested recovery action is not permission to execute it.

## Live work and publication

Use a fixed, merged integration candidate for live work; do not switch active services or the global shim to this feature branch. [LIVE-integration-validation](docs/tickets/LIVE-integration-validation.md) is the sole current live result index. Its source tickets own implementation/review gaps; fixed reports own bounded evidence. Load the [maintainer live-validation Skill](.agents/skills/grokbox-live-validation/SKILL.md) for an authorized integration window.

A merge, successful offline check, or index entry does not authorize restart/adoption, model spend, identity migration, irreversible cleanup, or publication. Stop only the affected action when its authorization, identity, result, or recovery is unknown; continue safe investigation and independent work.

Public bugs/proposals use GitHub Issues; security reports follow [SECURITY.md](SECURITY.md).
