## Goal
Content-addressed archive of official Host bundles by `sourceSha`, plus incremental diff and patch-impact report when official Gateway/Host churns.

## Why
Official will keep changing Host (harness/token/efficiency). Contracts today only keep ~5 generations of **contract slices** (knife-point drift). Silent replace without prior full bytes loses the upstream delta and patch-impact analysis. Patching still must not rewrite `host-main.cjs` in place.

## Scope
- Append-only full-bundle store keyed by sourceSha (isolated from transform path)
- On new observe: retain bytes, diff vs previous retained SHA, map to slice/patch impact
- CLI/read surfaces for operators; prune policy that never drops current live SHA or last profile-matched SHA without explicit policy
- Docs update in `docs/box-runtime.md`

## Out of scope
- In-place Host rewrite / `host-main.copy.cjs` patch bench
- Auto live re-adopt on drift

## Driver
Herdr (grok). Cite this issue key in the session prompt.
