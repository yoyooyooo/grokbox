# Agent Instructions

## Product boundary

`grokbox` is this project's canonical npm package and CLI name. `gbox` is an exact binary alias. Grok Bot is the upstream product being controlled; do not rename upstream protocol, product, or provider identifiers.

## Documentation

Read `CONTEXT.md` and `docs/README.md` before changing product boundaries. Product and architecture documents may describe accepted behavior beyond the current implementation; source and executable tests own current implementation truth.

## Upstream research boundary

This public repository is self-contained for build, test, review, and contribution. Maintainers may have separate private upstream research, but it is never a public dependency or implementation authority. Keep only the minimum source-backed interoperability facts required by grokbox in `docs/upstream-integration.md` and fake-provider tests. Never copy provider dumps, private application code, credentials, transcripts, or machine-local evidence into this repository.

## Issues

Public bugs and proposals use GitHub Issues. Security reports use the private route in `SECURITY.md`.

## Security

Do not put Cursor, Gateway, daemon, SSH, or tailnet credentials in argv, fixtures, snapshots, output, or ordinary logs. Keep Gateway, daemon, Sandbox, and quota capabilities separate.
