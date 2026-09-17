# Agent Instructions

## Product boundary

`grokbox` is this project's canonical **published** npm package and CLI name. `gbox` is an exact binary alias. Implementation lives in unpublished workspaces `packages/cli` and `packages/box-runtime`. Grok Bot is the upstream product being controlled; do not rename upstream protocol, product, or provider identifiers.

## Documentation

Read `CONTEXT.md` and `docs/README.md` before changing product boundaries. Product and architecture documents may describe accepted behavior beyond the current implementation; source and executable tests own current implementation truth.

## Upstream research boundary

This public repository is self-contained for build, test, review, and contribution. Maintainers may have separate private upstream research, but it is never a public dependency or implementation authority. Keep only the minimum source-backed interoperability facts required by grokbox in `docs/upstream-integration.md` and fake-provider tests. Never copy provider dumps, private application code, credentials, transcripts, or machine-local evidence into this repository.

## Box-local model runtime

Accepted design is `docs/box-runtime.md`. Product obligations are `docs/product-contract.md` §12. Composition roots are `docs/architecture.md` §17. Follow the [Effect adoption standard](docs/effect-box-runtime.md) for box-runtime side effects and incremental migration. Delivery slices, if any, stay machine-local and are not a public git dependency.

## Parallel worktrees and live acceptance

Finish code, offline tests and code review in the feature worktree. [`docs/tickets/LIVE-integration-validation.md`](docs/tickets/LIVE-integration-validation.md) is the **only current live-acceptance index**: every dimension must show proved scope, concrete unverified items, blocker, next action and links to its source contract and dated receipts. Preserve feature-scoped stable IDs/anchors. Source tickets own implementation/offline/review; runbooks own procedure; reports preserve fixed-window evidence. They link back to the relevant LIVE row instead of maintaining another current live status table or readiness ledger. Keep non-live blockers in the source ticket and expose only their gating effect in LIVE. Default live validation uses one fixed, revalidated integration commit on `feat/box-runtime-v2`; do not switch the active Host/modeld or global shim to an unmerged feature branch just to validate it. Index registration and merge do not authorize restart, adoption, model spend or publication. Update affected rows and receipt links after each window; one successful restart does not close the entire index.

## Issues

Public bugs and proposals use GitHub Issues. Security reports use the private route in `SECURITY.md`.

## Security

Do not put Cursor, Gateway, daemon, SSH, or tailnet credentials in argv, fixtures, snapshots, output, or ordinary logs. Keep Gateway, daemon, Sandbox, and quota capabilities separate.
