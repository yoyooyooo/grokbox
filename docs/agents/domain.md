# Domain Docs

This repository uses a single-context domain documentation layout.

## Before Exploring

Read these surfaces when they exist and are relevant:

- `CONTEXT.md` at the repository root for the domain glossary and accepted model.
- `docs/adr/` for accepted technical decisions affecting the work.
- `docs/README.md` for routes to the current product, architecture, compatibility, and roadmap homes.

Missing optional surfaces are not blockers. Proceed silently rather than creating empty structure for symmetry.

## Vocabulary

Use terms owned by the relevant Current Home. For the CLI, Profile, daemon, transport, and capability vocabulary, `docs/product-contract.md` is the product contract and `docs/architecture.md` owns implementation boundaries.

If proposed work conflicts with an ADR or Current Home, state the conflict explicitly rather than silently changing vocabulary or authority. `docs/roadmap/` contains deferred candidates and bounded future investigations only; it does not override a Current Home or prove delivery.
